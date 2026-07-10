# Code Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Build **phase by phase** — each phase is an independent, shippable unit.

**Goal:** Add a **Code Insights** area to the Clauge desktop dashboard — a "Code Output" section (lines written, time spent, opt-in git commit value) and a heuristic "How you use Claude Code" reflection section (task-mix over time, work rhythm, historical lookback) — mirroring the *locally-reachable* subset of Anthropic's org-only Claude Code analytics and the new Reflect dashboard, then publish the new metrics into the Mac→iPhone snapshot for a later iOS release.

**Architecture:** New **pure** `lib/` modules (`code-output.js`, `git-value.js`, `reflection.js`) plug into the existing sidecar. `code-output` rides the same JSONL walk `summarizeSession` already does (parse-time, cached); `git-value` is opt-in and spawns **read-only** git through an injected seam; `reflection` reuses the existing `classifyAll` / `rollupByHour` / `rollupByDay`. Each exposes a `GET /api/*` route consumed by a new dashboard section, and adds an **additive optional key** to `lib/snapshot.js` (schemaVersion stays 1). No LLM, no new runtime dependency.

**Tech Stack:** Node sidecar (Hono, ESM, `node --test`), read-only `git` via an injected spawn seam, vanilla-JS dashboard (`public/`). Rust/Tauri untouched except where a route needs wiring (none expected — routes are sidecar-only).

**Spec:** `docs/superpowers/specs/2026-07-10-code-insights-design.md` (authoritative — feasibility map, decisions, out-of-scope, risks). **Handoff:** `docs/superpowers/handoffs/2026-07-10-code-insights-handoff.md`.

## Global Constraints

Every task's requirements implicitly include these (copied from the spec + AGENTS.md):

- **ESM** repo (`"type":"module"`); dual-mode test helpers are IIFE + `window` global + `vm.runInThisContext`, never CommonJS (landmine #38).
- **Clock is injected** — `nowMs` / `tz` are parameters in every `lib/` function; never `Date.now()` / `new Date()` inside `lib/` (mirrors `lib/projection.js`).
- **No `console.log`** in `lib/` or `popover/` (validator-enforced; `.error`/`.warn` allowed).
- **Tests** live at `test/<name>.test.js`, run via `node --test` — NOT a new directory (landmine #14).
- **The gate is `npm run check`** (validators + `cargo fmt` + `clippy -D` + `cargo test` + `npm test`), run after `npm run build:sidecar`. A subset passing ≠ green (landmine #29). Never pipe a gate through `head`/`tail`.
- **Branch → PR → `gh pr checks --watch` → per-PR merge approval → squash.** Never push/merge `main` directly.
- **Snapshot is a cross-repo contract** — new keys are **additive OPTIONAL** only; **schemaVersion STAYS 1** (landmine #37); never emit a bare `null` in a slot iOS types as non-optional (review finding #26 — a single null blanks the whole iOS Analytics tab).
- **Reflection is heuristic + local** — no LLM, no API key, no topic-mining of prompt text (design invariant, not an optimization).
- **Git is read-only** — `git-value` may only construct `log` / `rev-parse`; a mutating subcommand is a bug a test must catch.
- New **served** frontend JS files must be in BOTH SEA manifests (landmine #2/#39). Adding render code to the existing `public/app.js` avoids this; a new served `.js` file does not.
- **Money:** cost is always recomputed from rates (never read `costUSD`); snapshot money is DOLLARS (data-contract rules #3/#4).

## Phase / PR overview

| Phase | Independent? | New `lib/` | New route(s) | Snapshot key | Notes |
|---|---|---|---|---|---|
| 1 — Code Output | yes (start here) | `code-output.js` | `GET /api/code-output` | `codeOutput` | no deps, no new libs; `durationMs` already exists |
| 2 — Git Value | needs P1 dashboard area | `git-value.js` | `GET /api/git-value`, `POST /api/config/git-value` | `gitValue` (when enabled) | opt-in, read-only git, security-first |
| 3 — Reflection | needs P1 area | `reflection.js` | `GET /api/reflection` | `reflection` | reuses classifier/hour/day; extends period vocab |
| 4 — iOS surfacing | separate repo/release | — | — | reads all three | own spec+plan at build time; bundles review P1 #26 fix |

Build Phase 1 → 2 → 3 on desktop, each as its own PR set. Phase 4 is a separate `clauge-ios` engagement.

---

# Code Insights — Phase 1: Code Output (desktop) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is a strict TDD loop: write the failing test → run it and see it fail → implement the minimum → run it and see it pass → commit.

**Goal:** Surface how much code Claude Code produced and how long it took. Add a pure `lib/code-output.js` that counts lines written from `Edit` / `Write` / `MultiEdit` tool calls, wire a per-session `codeOutput` field into `summarizeSession`, expose a period-aggregated `GET /api/code-output`, add a "Code Output" dashboard section, and publish an additive optional `codeOutput` snapshot key. **No git, no new dependencies, no schema bump.**

**Architecture:** All new math is a **pure** ESM module `lib/code-output.js` with two exports — `analyzeCodeOutput(turns)` (per-session, called at parse time inside `summarizeSession`, so it rides the already-walked `turns` and is cached with the summary — no new unbounded pass, landmine #41) and `aggregateCodeOutput(sessions)` (cross-session rollup, reused by both the route and the snapshot so they cannot drift). The route follows the existing thin `app.get('/api/...')` Hono pattern in `server.js`. The dashboard follows the existing `refreshAll()` + surgical-render pattern in `public/app.js` (headline numbers via `setTextIfChanged`, breakdown lists via `innerHTML` exactly like `renderToolLists` — landmine #22). The snapshot adds one optional top-level key in `lib/snapshot.js` with `SNAPSHOT_SCHEMA_VERSION` unchanged at `1` (landmine #37).

**Tech Stack:** Node sidecar (Hono, ESM, `node:test`), vanilla-JS dashboard (no framework, no build step). No Rust in Phase 1.

**Spec (authoritative):** `docs/superpowers/specs/2026-07-10-code-insights-design.md` — §"Components → `lib/code-output.js`", §"Routes", §"Dashboard", §"Snapshot".

---

## Pinned cross-phase contract (do NOT rename — Phases 2–4 depend on these EXACT names)

- **Per session** (attached by `summarizeSession`):
  ```
  session.codeOutput = {
    linesAdded:   number,
    linesRemoved: number,
    linesNet:     number,                       // linesAdded − linesRemoved
    byTool:  { Edit: number, Write: number, MultiEdit: number },  // INVOCATION COUNTS
    editCount:    number,                        // == byTool.Edit + byTool.Write + byTool.MultiEdit
  }
  ```
  `byTool.*` are **counts of tool_use invocations** of that tool (not line counts). The invariant `byTool.Edit + byTool.Write + byTool.MultiEdit === editCount` is load-bearing and is asserted in tests.

- **`GET /api/code-output?period=`** response:
  ```
  {
    period, linesAdded, linesRemoved, linesNet, timeSpentMs,
    byDay:     [{ date, linesNet, timeSpentMs }],      // UTC calendar day, sorted date asc
    byProject: [{ project, linesNet, timeSpentMs }],   // sorted linesNet desc
    byTool:    { Edit, Write, MultiEdit },
  }
  ```

- **Snapshot key `codeOutput`** (trimmed for the phone — NO byDay/byProject):
  ```
  codeOutput = { linesAdded, linesRemoved, linesNet, timeSpentMs, byTool:{ Edit, Write, MultiEdit } }
  ```
  All fields are numbers defaulting to `0` — never `null` in a typed slot (review #26). `SNAPSHOT_SCHEMA_VERSION` STAYS `1`.

### Line math (pinned, honor exactly)

- `lineCount(s)` = `typeof s === 'string' ? s.split('\n').length : 0`. Note `lineCount('') === 1` (an empty string is one "line") — this is the spec's rule; it is asserted so it stays intentional.
- `Write`  → `linesAdded += lineCount(input.content)`.
- `Edit`   → `linesAdded += lineCount(input.new_string)`, `linesRemoved += lineCount(input.old_string)`.
- `MultiEdit` → for each `e` of `input.edits[]`: `linesAdded += lineCount(e.new_string)`, `linesRemoved += lineCount(e.old_string)`.
- Guard: a missing/non-string field contributes `0` lines, but the invocation **still** increments `byTool.*` and `editCount` (the tool was called even if its payload was odd). `MultiEdit` with `edits` not an array → `0` line contribution, still counts as one `MultiEdit` invocation.
- Only `assistant` turns are walked (same guard as `tool-analyzer.js:48`). `tool_use` blocks named anything other than `Edit`/`Write`/`MultiEdit` are ignored.

---

## PR / branch structure (Phase 1)

| PR | Branch | Tasks | Contents |
|----|--------|-------|----------|
| 1 | `feat/code-output-lib` | 1–2 | `lib/code-output.js` (`analyzeCodeOutput` pure) + wire `session.codeOutput` into `lib/aggregator.js::summarizeSession` |
| 2 | `feat/code-output-api` | 3 | `aggregateCodeOutput` pure export (in `lib/code-output.js`) + `GET /api/code-output` route + `READ_ONLY_API_PATHS` entry |
| 3 | `feat/code-output-snapshot` | 4 | optional `codeOutput` key in `lib/snapshot.js` (schemaVersion stays 1) |
| 4 | `feat/code-output-dashboard` | 5 | "Code Output" section in `public/index.html` + `public/app.js` render (surgical) + `public/styles.css` |

**Sequencing.** PR 1 first (defines `session.codeOutput`). PR 2 and PR 3 both depend only on PR 1 and are independent of each other (can be done in either order). PR 4 depends on PR 2 (it fetches `/api/code-output`). Branch each PR from a fresh `main` **after** the previous merges.

**Each PR (house rules, non-negotiable):**
- ESM only (`"type":"module"` in `package.json`); `lib/` modules are pure — no `Date.now()` inside `lib/` (inject `nowMs`/clock as a param); no `console.log` in `lib/` or `popover/` (a `check:validators` step enforces this).
- Tests live at `test/<name>.test.js` (NOT a new directory — landmine #14) and run via `node --test <file>`.
- Full gate before every merge: `npm run build:sidecar && npm run check` (the SEA bundle must be rebuilt first so the sidecar validators see current code — landmine #29; `npm run check` runs validators + `fmt` + `lint` + rust-test + `npm test`). Do **not** pipe the gate through `tail`/`grep` — it masks the exit code.
- Conventional Commits. Never push or merge to `main` directly: branch → `gh pr create` → `gh pr checks --watch` → per-PR merge approval → `gh pr merge --squash`.
- **SEA manifest note (landmine #2/#39):** Phase 1 adds render code to the *existing* served files `public/index.html`, `public/app.js`, `public/styles.css` — all already in both SEA manifests. **No new served frontend JS file is added, so no manifest edit is required.** If a future task extracts a *new* `public/*.js`, it MUST be added to both `sea-config.json` and `sea-bootstrap.cjs`'s `ASSETS` array or it 404s silently.

---

## PR 1 — `feat/code-output-lib` (Tasks 1–2)

> Two changes: the pure line-counting module (Task 1) and its one-line wiring into the session summary (Task 2). No I/O, no clock, no new deps. House rules in force (ESM, pure `lib/`, no `console.log`, `test/*.test.js`).

---

### Task 1: `lib/code-output.js` — `analyzeCodeOutput(turns)` (pure) + tests

**Files**
- Create: `/Users/adnanrashid/Projects/clauge/lib/code-output.js`
- Create: `/Users/adnanrashid/Projects/clauge/test/code-output.test.js`

**Interfaces**
- **Consumes:** `turns` — the deduped turn array from `lib/parser.js::parseSession`. Each `assistant` turn has `turn.contentBlocks: Array<{ type, name?, input? }>`; `tool_use` blocks carry `.name` (`'Edit'|'Write'|'MultiEdit'|...`) and `.input` (`Edit`→`{old_string,new_string}`, `Write`→`{content}`, `MultiEdit`→`{edits:[{old_string,new_string}]}`). Same walk shape as `tool-analyzer.js:47-51`.
- **Produces:** `analyzeCodeOutput(turns) → { linesAdded, linesRemoved, linesNet, byTool:{Edit,Write,MultiEdit}, editCount }` (the pinned per-session contract above).

**Steps**

- [ ] **Step 1: Write the failing test file `test/code-output.test.js`.** Complete file:

  ```js
  // Unit tests for lib/code-output.js — pure "lines written" counter
  // (Code Insights Phase 1, docs/superpowers/specs/2026-07-10-code-insights-design.md).
  // Walks the SAME tool_use shape as tool-analyzer.js. No clock, no I/O.

  import { describe, it } from 'node:test';
  import assert from 'node:assert/strict';
  import { analyzeCodeOutput } from '../lib/code-output.js';

  // Block + turn builders (mirror test/tool-analyzer.test.js).
  const tool = (name, input = {}) => ({ type: 'tool_use', name, input });
  const turn = (blocks) => ({ type: 'assistant', contentBlocks: blocks });

  describe('analyzeCodeOutput — Write', () => {
    it('adds lineCount(content); counts the Write invocation', () => {
      const out = analyzeCodeOutput([turn([tool('Write', { content: 'a\nb\nc' })])]);
      assert.equal(out.linesAdded, 3);
      assert.equal(out.linesRemoved, 0);
      assert.equal(out.linesNet, 3);
      assert.deepEqual(out.byTool, { Edit: 0, Write: 1, MultiEdit: 0 });
      assert.equal(out.editCount, 1);
    });
  });

  describe('analyzeCodeOutput — Edit', () => {
    it('adds new_string lines, removes old_string lines, net = new − old', () => {
      const out = analyzeCodeOutput([
        turn([tool('Edit', { old_string: 'x', new_string: 'y\nz' })]),
      ]);
      assert.equal(out.linesAdded, 2); // y\nz
      assert.equal(out.linesRemoved, 1); // x
      assert.equal(out.linesNet, 1);
      assert.deepEqual(out.byTool, { Edit: 1, Write: 0, MultiEdit: 0 });
      assert.equal(out.editCount, 1);
    });
  });

  describe('analyzeCodeOutput — MultiEdit', () => {
    it('sums the Edit rule over input.edits[]', () => {
      const out = analyzeCodeOutput([
        turn([
          tool('MultiEdit', {
            edits: [
              { old_string: 'p', new_string: 'p\nq' }, // +2 −1
              { old_string: 'r\ns', new_string: 't' }, // +1 −2
            ],
          }),
        ]),
      ]);
      assert.equal(out.linesAdded, 3);
      assert.equal(out.linesRemoved, 3);
      assert.equal(out.linesNet, 0);
      assert.deepEqual(out.byTool, { Edit: 0, Write: 0, MultiEdit: 1 });
      assert.equal(out.editCount, 1);
    });

    it('counts a MultiEdit invocation even when edits is missing/not an array', () => {
      const out = analyzeCodeOutput([turn([tool('MultiEdit', { edits: 'oops' })])]);
      assert.equal(out.linesAdded, 0);
      assert.equal(out.linesRemoved, 0);
      assert.deepEqual(out.byTool, { Edit: 0, Write: 0, MultiEdit: 1 });
      assert.equal(out.editCount, 1);
    });
  });

  describe('analyzeCodeOutput — lineCount edge rules (pinned)', () => {
    it("treats the empty string as one line (lineCount('') === 1)", () => {
      // Write with content '' contributes exactly 1 added line, per spec.
      const out = analyzeCodeOutput([turn([tool('Write', { content: '' })])]);
      assert.equal(out.linesAdded, 1);
    });

    it('guards non-string / missing fields to 0 lines but still counts the invocation', () => {
      const out = analyzeCodeOutput([
        turn([
          tool('Write', {}), // no content
          tool('Edit', { old_string: 5, new_string: null }), // non-strings
        ]),
      ]);
      assert.equal(out.linesAdded, 0);
      assert.equal(out.linesRemoved, 0);
      assert.deepEqual(out.byTool, { Edit: 1, Write: 1, MultiEdit: 0 });
      assert.equal(out.editCount, 2);
    });
  });

  describe('analyzeCodeOutput — ignores', () => {
    it('ignores non-Edit/Write/MultiEdit tools (Read, Bash)', () => {
      const out = analyzeCodeOutput([
        turn([tool('Read', { file_path: '/x' }), tool('Bash', { command: 'ls' })]),
      ]);
      assert.equal(out.editCount, 0);
      assert.deepEqual(out.byTool, { Edit: 0, Write: 0, MultiEdit: 0 });
    });

    it('ignores non-assistant turns', () => {
      const userTurn = { type: 'user', contentBlocks: [tool('Write', { content: 'a\nb' })] };
      const out = analyzeCodeOutput([userTurn]);
      assert.equal(out.editCount, 0);
      assert.equal(out.linesAdded, 0);
    });

    it('null / empty input → fully zeroed shape', () => {
      const zero = { linesAdded: 0, linesRemoved: 0, linesNet: 0, byTool: { Edit: 0, Write: 0, MultiEdit: 0 }, editCount: 0 };
      assert.deepEqual(analyzeCodeOutput(null), zero);
      assert.deepEqual(analyzeCodeOutput([]), zero);
      assert.deepEqual(analyzeCodeOutput([turn([])]), zero);
    });
  });

  describe('analyzeCodeOutput — invariant', () => {
    it('byTool counts sum to editCount', () => {
      const out = analyzeCodeOutput([
        turn([
          tool('Write', { content: 'a' }),
          tool('Edit', { old_string: 'a', new_string: 'b' }),
          tool('MultiEdit', { edits: [{ old_string: 'c', new_string: 'd' }] }),
          tool('Edit', { old_string: 'e', new_string: 'f' }),
        ]),
      ]);
      assert.equal(out.byTool.Edit + out.byTool.Write + out.byTool.MultiEdit, out.editCount);
      assert.equal(out.editCount, 4);
    });
  });
  ```

- [ ] **Step 2: Run the test — verify it FAILS.**
  Command: `node --test test/code-output.test.js`
  Expected: `Cannot find module '../lib/code-output.js'` (`ERR_MODULE_NOT_FOUND`) — the module does not exist yet.

- [ ] **Step 3: Implement `lib/code-output.js`.** Complete file:

  ```js
  /**
   * Pure "lines written" analytics (Code Insights Phase 1).
   * Spec: docs/superpowers/specs/2026-07-10-code-insights-design.md
   *
   * An honest LOCAL analogue of Anthropic's org-only "lines accepted": we count
   * the lines Claude WROTE via the Edit / Write / MultiEdit tools in the session
   * logs — never IDE-acceptance (we can't see that). Walks the same tool_use
   * shape as tool-analyzer.js. No I/O, no clock, no DOM.
   *
   * analyzeCodeOutput(turns) runs at parse time inside summarizeSession, so it
   * rides the turns already walked and is cached with the summary (no new
   * unbounded pass — landmine #41). aggregateCodeOutput(sessions) rolls the
   * per-session field up across a period; the route AND the snapshot both call
   * it, so they cannot drift.
   */

  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

  /**
   * Line count of a value: number of '\n'-split segments, or 0 when not a
   * string. Note lineCount('') === 1 (an empty string is one line) — pinned.
   * @param {unknown} s
   * @returns {number}
   */
  function lineCount(s) {
    return typeof s === 'string' ? s.split('\n').length : 0;
  }

  /**
   * Per-session code-output totals from the deduped turns.
   *
   * @param {Array} turns turns from parser.parseSession (user + assistant)
   * @returns {{ linesAdded:number, linesRemoved:number, linesNet:number,
   *   byTool:{Edit:number,Write:number,MultiEdit:number}, editCount:number }}
   */
  export function analyzeCodeOutput(turns) {
    let linesAdded = 0;
    let linesRemoved = 0;
    let editCount = 0;
    const byTool = { Edit: 0, Write: 0, MultiEdit: 0 };

    for (const turn of turns ?? []) {
      if (turn?.type !== 'assistant') continue;
      for (const block of turn.contentBlocks ?? []) {
        if (block?.type !== 'tool_use' || !EDIT_TOOLS.has(block.name)) continue;
        const name = block.name;
        const input = block.input ?? {};

        if (name === 'Write') {
          linesAdded += lineCount(input.content);
        } else if (name === 'Edit') {
          linesAdded += lineCount(input.new_string);
          linesRemoved += lineCount(input.old_string);
        } else {
          // MultiEdit
          const edits = Array.isArray(input.edits) ? input.edits : [];
          for (const e of edits) {
            linesAdded += lineCount(e?.new_string);
            linesRemoved += lineCount(e?.old_string);
          }
        }

        // Invocation is counted regardless of payload shape (the tool ran).
        byTool[name] += 1;
        editCount += 1;
      }
    }

    return {
      linesAdded,
      linesRemoved,
      linesNet: linesAdded - linesRemoved,
      byTool,
      editCount,
    };
  }
  ```

- [ ] **Step 4: Run the test — verify it PASSES.**
  Command: `node --test test/code-output.test.js`
  Expected: all pass (`# fail 0`).

- [ ] **Step 5: Commit.**
  ```bash
  git add lib/code-output.js test/code-output.test.js
  git commit -m "feat(code-insights): pure analyzeCodeOutput — lines written from Edit/Write/MultiEdit"
  ```

---

### Task 2: Wire `session.codeOutput` into `summarizeSession`

**Files**
- Modify: `/Users/adnanrashid/Projects/clauge/lib/aggregator.js` (add import; call `analyzeCodeOutput(turns)`; add `codeOutput` to the returned object).
- Modify: `/Users/adnanrashid/Projects/clauge/test/aggregator.test.js` (append one assertion block).

**Interfaces**
- **Consumes:** `analyzeCodeOutput` (Task 1); the `turns` already in scope inside `summarizeSession`.
- **Produces:** `session.codeOutput` on every summary (the pinned per-session shape). Computed on the same `turns` `analyzeTools`/`classifyAll` already walk — one extra bounded pass, cached with the summary (landmine #41: no new fan-out over `loadAllSummaries`).

**Steps**

- [ ] **Step 1: Write the failing test.** Append this `describe` block to the END of `test/aggregator.test.js` (after the last existing block). It reuses the file's existing `makeSession` helper, whose fabricated assistant turn already contains an `Edit` block (`test/aggregator.test.js:50`):

  ```js
  describe('summarizeSession — codeOutput field (Code Insights Phase 1)', () => {
    it('attaches session.codeOutput with the pinned shape from the Edit block', () => {
      // makeSession()'s first assistant turn has contentBlocks [Edit, Bash];
      // the Edit here carries no old/new strings, so lines are 0 but the
      // invocation is counted (byTool.Edit === 1, editCount === 1).
      const turns = makeSession({
        tokens: { inputTokens: 10, outputTokens: 20, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 },
        startedAt: '2026-05-06T10:00:00.000Z',
      });
      const summary = summarizeSession(turns, { priceTable, envFallback: env });

      assert.ok(summary.codeOutput, 'codeOutput present');
      assert.deepEqual(Object.keys(summary.codeOutput).sort(), [
        'byTool', 'editCount', 'linesAdded', 'linesNet', 'linesRemoved',
      ]);
      assert.equal(summary.codeOutput.byTool.Edit, 1);
      assert.equal(summary.codeOutput.editCount, 1);
      assert.equal(
        summary.codeOutput.byTool.Edit +
          summary.codeOutput.byTool.Write +
          summary.codeOutput.byTool.MultiEdit,
        summary.codeOutput.editCount,
      );
    });
  });
  ```

- [ ] **Step 2: Run the test — verify it FAILS.**
  Command: `node --test test/aggregator.test.js`
  Expected: the new test fails (`summary.codeOutput` is `undefined`); the existing tests still pass.

- [ ] **Step 3: Implement the wiring in `lib/aggregator.js`.**

  3a. Add the import beside the other `lib/` imports (anchor: immediately after `import { analyzeTools } from './tool-analyzer.js';`, `aggregator.js:21`):
  ```js
  import { analyzeCodeOutput } from './code-output.js';
  ```

  3b. Compute it next to the existing `tools` walk (anchor: immediately after `const tools = analyzeTools(turns);`, `aggregator.js:101`):
  ```js
  const codeOutput = analyzeCodeOutput(turns);
  ```

  3c. Add the field to the returned object (anchor: after `tools,` in the `return {…}` block, `aggregator.js:128`):
  ```js
      tools,
      codeOutput,
  ```

- [ ] **Step 4: Run the test — verify it PASSES.**
  Command: `node --test test/aggregator.test.js`
  Expected: all pass, including the existing `summarizeSession` suite (regression check).

- [ ] **Step 5: Full gate + commit.**
  ```bash
  npm run build:sidecar && npm run check
  git add lib/aggregator.js test/aggregator.test.js
  git commit -m "feat(code-insights): attach session.codeOutput in summarizeSession"
  ```
  Then open the PR: `gh pr create` → `gh pr checks --watch` → (approval) → `gh pr merge --squash`.

---

## PR 2 — `feat/code-output-api` (Task 3, after PR 1 merges)

> **Precondition (on `main`):** `session.codeOutput` is attached by `summarizeSession` (PR 1). This PR adds the cross-session rollup `aggregateCodeOutput(sessions)` (pure, in `lib/code-output.js`) and the thin `GET /api/code-output` route that wraps it, and registers the route in the loopback CORS allowlist so the webview can read it. House rules in force.

---

### Task 3: `aggregateCodeOutput(sessions)` + `GET /api/code-output`

**Files**
- Modify: `/Users/adnanrashid/Projects/clauge/lib/code-output.js` (add second export `aggregateCodeOutput`).
- Modify: `/Users/adnanrashid/Projects/clauge/test/code-output.test.js` (append `aggregateCodeOutput` unit tests).
- Modify: `/Users/adnanrashid/Projects/clauge/server.js` (import; add `/api/code-output` to `READ_ONLY_API_PATHS`; add the route handler).
- Create: `/Users/adnanrashid/Projects/clauge/test/server-code-output.test.js` (spawned-server integration test — CORS + numbers + invalid-period 400).

**Interfaces**
- **Consumes:** `session.codeOutput` (PR 1); `session.durationMs`, `session.startedAt`, `session.project` (all already produced by `summarizeSession`); `loadFiltered(c)` in `server.js` (period-filtered sessions via `filterSessions` — `server.js:125`); `isValidPeriod` (already gates `parseFilters`).
- **Produces:** `aggregateCodeOutput(sessions) → { linesAdded, linesRemoved, linesNet, timeSpentMs, byDay, byProject, byTool }`; `GET /api/code-output?period=` → `{ period, ...aggregateCodeOutput(filtered) }` (the pinned route contract).

**Steps**

- [ ] **Step 1: Write the failing unit tests for `aggregateCodeOutput`.** Append to the END of `test/code-output.test.js`:

  ```js
  import { aggregateCodeOutput } from '../lib/code-output.js';

  // Minimal session summary carrying only the fields aggregateCodeOutput reads.
  function sess(overrides = {}) {
    return {
      project: overrides.project ?? 'demo',
      startedAt: overrides.startedAt ?? '2026-07-01T10:00:00.000Z',
      durationMs: overrides.durationMs ?? 60_000,
      codeOutput: overrides.codeOutput ?? {
        linesAdded: 10, linesRemoved: 4, linesNet: 6,
        byTool: { Edit: 2, Write: 1, MultiEdit: 0 }, editCount: 3,
      },
    };
  }

  describe('aggregateCodeOutput — cross-session rollup', () => {
    it('sums totals, timeSpentMs (from durationMs), and byTool across sessions', () => {
      const out = aggregateCodeOutput([sess(), sess()]);
      assert.equal(out.linesAdded, 20);
      assert.equal(out.linesRemoved, 8);
      assert.equal(out.linesNet, 12);
      assert.equal(out.timeSpentMs, 120_000);
      assert.deepEqual(out.byTool, { Edit: 4, Write: 2, MultiEdit: 0 });
    });

    it('groups byDay (UTC day, sorted asc) and byProject (sorted linesNet desc)', () => {
      const out = aggregateCodeOutput([
        sess({ project: 'alpha', startedAt: '2026-07-02T09:00:00Z', durationMs: 1000,
          codeOutput: { linesAdded: 3, linesRemoved: 1, linesNet: 2, byTool: { Edit: 1, Write: 0, MultiEdit: 0 }, editCount: 1 } }),
        sess({ project: 'beta', startedAt: '2026-07-01T09:00:00Z', durationMs: 2000,
          codeOutput: { linesAdded: 30, linesRemoved: 0, linesNet: 30, byTool: { Edit: 0, Write: 1, MultiEdit: 0 }, editCount: 1 } }),
      ]);
      assert.deepEqual(out.byDay.map((d) => d.date), ['2026-07-01', '2026-07-02']); // asc
      assert.equal(out.byDay[0].timeSpentMs, 2000);
      assert.equal(out.byProject[0].project, 'beta'); // linesNet 30 > 2
      assert.deepEqual(out.byProject.map((p) => p.project), ['beta', 'alpha']);
    });

    it('tolerates sessions missing codeOutput (old cached summaries) and null durationMs', () => {
      const out = aggregateCodeOutput([
        { project: 'x', startedAt: '2026-07-01T10:00:00Z', durationMs: null }, // no codeOutput
        sess({ project: 'x', durationMs: 5000 }),
      ]);
      assert.equal(out.timeSpentMs, 5000); // null durationMs → 0
      assert.equal(out.linesAdded, 10); // only the second session contributes
    });

    it('null / empty input → zeroed totals + empty arrays', () => {
      for (const input of [null, []]) {
        const out = aggregateCodeOutput(input);
        assert.equal(out.linesAdded, 0);
        assert.equal(out.linesRemoved, 0);
        assert.equal(out.linesNet, 0);
        assert.equal(out.timeSpentMs, 0);
        assert.deepEqual(out.byDay, []);
        assert.deepEqual(out.byProject, []);
        assert.deepEqual(out.byTool, { Edit: 0, Write: 0, MultiEdit: 0 });
      }
    });
  });
  ```

- [ ] **Step 2: Run the test — verify it FAILS.**
  Command: `node --test test/code-output.test.js`
  Expected: the new `aggregateCodeOutput` block fails with `aggregateCodeOutput is not a function` (or an import error); the Task-1 tests still pass.

- [ ] **Step 3: Implement `aggregateCodeOutput` in `lib/code-output.js`.** Append this export to the END of the file:

  ```js
  /**
   * Roll per-session codeOutput up across a (period-filtered) session set.
   * Pure. Sessions missing codeOutput (older cached summaries) contribute 0;
   * a null durationMs contributes 0 time. byDay uses the UTC calendar day
   * (matches aggregator.rollupByDay); byProject is sorted linesNet desc.
   *
   * @param {Array} sessions session summaries (each may carry .codeOutput,
   *   .durationMs, .startedAt, .project)
   * @returns {{ linesAdded:number, linesRemoved:number, linesNet:number,
   *   timeSpentMs:number,
   *   byDay:Array<{date:string,linesNet:number,timeSpentMs:number}>,
   *   byProject:Array<{project:string,linesNet:number,timeSpentMs:number}>,
   *   byTool:{Edit:number,Write:number,MultiEdit:number} }}
   */
  export function aggregateCodeOutput(sessions) {
    let linesAdded = 0;
    let linesRemoved = 0;
    let timeSpentMs = 0;
    const byTool = { Edit: 0, Write: 0, MultiEdit: 0 };
    const dayMap = new Map(); // date -> {date, linesNet, timeSpentMs}
    const projMap = new Map(); // project -> {project, linesNet, timeSpentMs}

    for (const s of sessions ?? []) {
      if (!s) continue;
      const co = s.codeOutput ?? null;
      const added = co?.linesAdded ?? 0;
      const removed = co?.linesRemoved ?? 0;
      const net = added - removed;
      const dur = Number.isFinite(s.durationMs) ? s.durationMs : 0;

      linesAdded += added;
      linesRemoved += removed;
      timeSpentMs += dur;
      byTool.Edit += co?.byTool?.Edit ?? 0;
      byTool.Write += co?.byTool?.Write ?? 0;
      byTool.MultiEdit += co?.byTool?.MultiEdit ?? 0;

      const day = typeof s.startedAt === 'string' ? s.startedAt.slice(0, 10) : null;
      if (day) {
        const d = dayMap.get(day) ?? { date: day, linesNet: 0, timeSpentMs: 0 };
        d.linesNet += net;
        d.timeSpentMs += dur;
        dayMap.set(day, d);
      }

      const proj = s.project ?? 'unknown';
      const p = projMap.get(proj) ?? { project: proj, linesNet: 0, timeSpentMs: 0 };
      p.linesNet += net;
      p.timeSpentMs += dur;
      projMap.set(proj, p);
    }

    return {
      linesAdded,
      linesRemoved,
      linesNet: linesAdded - linesRemoved,
      timeSpentMs,
      byDay: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      byProject: [...projMap.values()].sort((a, b) => b.linesNet - a.linesNet),
      byTool,
    };
  }
  ```

- [ ] **Step 4: Run the unit test — verify it PASSES.**
  Command: `node --test test/code-output.test.js`
  Expected: all pass.

- [ ] **Step 5: Write the failing server-integration test `test/server-code-output.test.js`.** Models `test/server-snapshot-forecast.test.js` (spawn the real server) but points `CLAUDE_DIR` at a sandbox seeded with ONE session JSONL of known Edit/Write/MultiEdit blocks. Complete file:

  ```js
  // Integration test for GET /api/code-output. Spawns the real Hono server with
  // CLAUDE_DIR pointed at a tmp sandbox holding one seeded session transcript,
  // then asserts the aggregated line/time numbers, the byTool/byProject/byDay
  // rollups, loopback CORS reflection (READ_ONLY_API_PATHS membership), and the
  // invalid-period 400. The line MATH is unit-tested in test/code-output.test.js;
  // this suite proves the route wiring end-to-end through the real parser.

  import { describe, it, before, after } from 'node:test';
  import assert from 'node:assert/strict';
  import { spawn } from 'node:child_process';
  import http from 'node:http';
  import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  function startServer(envOverrides) {
    const child = spawn('node', ['server.js'], {
      env: { ...process.env, NO_OPEN: '1', ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server start timeout')); }, 8000);
      child.stdout.on('data', (buf) => {
        if (buf.toString().includes('Listening on')) { clearTimeout(timer); resolve(child); }
      });
      child.on('error', reject);
    });
  }

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
            try { body = JSON.parse(buf); } catch { /* non-JSON */ }
            resolve({ status: res.statusCode, acao: res.headers['access-control-allow-origin'] ?? null, body });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  // One session under <claudeDir>/projects/demo/s1.jsonl:
  //   Write content 'a\nb\nc'            -> +3 added
  //   Edit  old 'x' / new 'y\nz'         -> +2 added, +1 removed
  //   MultiEdit [{p -> p\nq}, {r\ns -> t}] -> +3 added, +3 removed
  // Totals: added 8, removed 4, net 4. byTool Write 1, Edit 1, MultiEdit 1.
  // Two assistant turns 5 min apart -> durationMs 300000 -> timeSpentMs 300000.
  async function seedClaudeDir(claudeDir) {
    const projDir = join(claudeDir, 'projects', 'demo');
    await mkdir(projDir, { recursive: true });
    const lines = [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 's1', timestamp: '2026-07-01T10:00:00.000Z', cwd: '/Users/test/Projects/demo', gitBranch: 'main', version: '2.1.121', message: { role: 'user', content: 'do it' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 's1', requestId: 'req_A', timestamp: '2026-07-01T10:05:00.000Z', cwd: '/Users/test/Projects/demo', gitBranch: 'main', version: '2.1.121', message: { model: 'claude-opus-4-7', usage: { input_tokens: 10, output_tokens: 20 }, content: [
        { type: 'tool_use', name: 'Write', input: { content: 'a\nb\nc' } },
        { type: 'tool_use', name: 'Edit', input: { old_string: 'x', new_string: 'y\nz' } },
      ] } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u1', sessionId: 's1', requestId: 'req_B', timestamp: '2026-07-01T10:10:00.000Z', cwd: '/Users/test/Projects/demo', gitBranch: 'main', version: '2.1.121', message: { model: 'claude-opus-4-7', usage: { input_tokens: 5, output_tokens: 10 }, content: [
        { type: 'tool_use', name: 'MultiEdit', input: { edits: [{ old_string: 'p', new_string: 'p\nq' }, { old_string: 'r\ns', new_string: 't' }] } },
      ] } },
    ];
    await writeFile(join(projDir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  describe('GET /api/code-output', () => {
    let server, claudeDir;
    const PORT = '3547';
    const ORIGIN = `http://127.0.0.1:${PORT}`;

    before(async () => {
      claudeDir = await mkdtemp(join(tmpdir(), 'clauge-code-output-'));
      await seedClaudeDir(claudeDir);
      server = await startServer({ PORT, CLAUDE_DIR: claudeDir });
    });

    after(async () => {
      if (server && !server.killed) {
        server.kill('SIGTERM');
        await new Promise((r) => server.once('exit', r));
      }
      await rm(claudeDir, { recursive: true, force: true });
    });

    it('aggregates lines / time / byTool over the seeded session (period=all)', async () => {
      const r = await getWithOrigin(PORT, '/api/code-output?period=all', ORIGIN);
      assert.equal(r.status, 200);
      assert.equal(r.body.period, 'all');
      assert.equal(r.body.linesAdded, 8);
      assert.equal(r.body.linesRemoved, 4);
      assert.equal(r.body.linesNet, 4);
      assert.equal(r.body.timeSpentMs, 300000);
      assert.deepEqual(r.body.byTool, { Edit: 1, Write: 1, MultiEdit: 1 });
      assert.deepEqual(r.body.byProject, [{ project: 'demo', linesNet: 4, timeSpentMs: 300000 }]);
      assert.deepEqual(r.body.byDay, [{ date: '2026-07-01', linesNet: 4, timeSpentMs: 300000 }]);
    });

    it('reflects the loopback Origin (READ_ONLY_API_PATHS membership)', async () => {
      const r = await getWithOrigin(PORT, '/api/code-output?period=all', ORIGIN);
      assert.equal(r.acao, ORIGIN);
    });

    it('rejects an invalid period with 400', async () => {
      const r = await getWithOrigin(PORT, '/api/code-output?period=bogus', ORIGIN);
      assert.equal(r.status, 400);
    });
  });
  ```

- [ ] **Step 6: Run the integration test — verify it FAILS.**
  Command: `node --test test/server-code-output.test.js`
  Expected: the route returns 404 (handler not yet added) → the numbers assertion fails / status is not 200.

- [ ] **Step 7: Implement the route in `server.js`.**

  7a. Import `aggregateCodeOutput` (anchor: extend the `lib/aggregator` import group, OR add a dedicated line after it — `server.js:36`). Add:
  ```js
  import { aggregateCodeOutput } from './lib/code-output.js';
  ```

  7b. Register the path in the loopback CORS allowlist so the webview can read it (anchor: add to the `READ_ONLY_API_PATHS` array, e.g. after the `'/api/projection',` entry, `server.js:205`):
  ```js
    '/api/code-output',
  ```

  7c. Add the handler next to the other read routes (anchor: immediately after the `app.get('/api/roi', …)` block ends at `server.js:565`). It mirrors `/api/roi`'s `{ period, ...pureFn(sessions) }` shape:
  ```js
  // Code Insights Phase 1: lines-written + time-spent, aggregated across the
  // period-filtered sessions. All math is pure (lib/code-output.js); this
  // handler only wires loadFiltered() to the aggregator, exactly like /api/roi.
  app.get('/api/code-output', async (c) => {
    const filtered = await loadFiltered(c);
    if (filtered.error) return c.json(filtered, 400);
    return c.json({ period: filtered.period, ...aggregateCodeOutput(filtered.sessions) });
  });
  ```

- [ ] **Step 8: Run the integration test — verify it PASSES.**
  Command: `node --test test/server-code-output.test.js`
  Expected: all pass (200, correct numbers, ACAO reflected, 400 on bad period).

- [ ] **Step 9: Full gate + commit.**
  ```bash
  npm run build:sidecar && npm run check
  git add lib/code-output.js server.js test/code-output.test.js test/server-code-output.test.js
  git commit -m "feat(code-insights): GET /api/code-output + aggregateCodeOutput rollup"
  ```
  PR: `gh pr create` → `gh pr checks --watch` → (approval) → `gh pr merge --squash`.

---

## PR 3 — `feat/code-output-snapshot` (Task 4, after PR 1 merges)

> **Precondition (on `main`):** `session.codeOutput` (PR 1). Independent of PR 2 — it reuses `aggregateCodeOutput` if PR 2 is already merged, but does NOT require the route. **If PR 2 has not merged yet**, this PR must land the `aggregateCodeOutput` export itself (it lives in `lib/code-output.js`, which PR 1 created). To avoid an ordering trap, **do PR 2 before PR 3** so `aggregateCodeOutput` is already on `main`; the steps below assume that order.

---

### Task 4: add optional `codeOutput` key to `buildSnapshot`

**Files**
- Modify: `/Users/adnanrashid/Projects/clauge/lib/snapshot.js` (import `aggregateCodeOutput`; add a trimmed `codeOutput` key).
- Modify: `/Users/adnanrashid/Projects/clauge/test/snapshot.test.js` (append assertions).

**Interfaces**
- **Consumes:** `aggregateCodeOutput(sessions)` (PR 2); the period-filtered `sessions` already in scope inside `buildSnapshot` (`snapshot.js:288`).
- **Produces:** `snapshot.codeOutput = { linesAdded, linesRemoved, linesNet, timeSpentMs, byTool:{Edit,Write,MultiEdit} }` — an ADDITIVE OPTIONAL top-level key. `SNAPSHOT_SCHEMA_VERSION` STAYS `1` (landmine #37). No `null` in any typed slot — all numbers default `0` (review #26). `byDay`/`byProject` are deliberately dropped to keep the phone payload small (the phone shows headline totals + per-tool split only; per-day activity is already covered by `snapshot.activity`).

**Steps**

- [ ] **Step 1: Write the failing test.** Append to `test/snapshot.test.js`. It extends the file's existing `makeSession` fakes with a `codeOutput` field so the snapshot has something to aggregate:

  ```js
  describe('buildSnapshot — codeOutput key (Code Insights Phase 1)', () => {
    const withCode = (overrides = {}) => ({
      ...makeSession(overrides),
      durationMs: overrides.durationMs ?? 60_000,
      codeOutput: overrides.codeOutput ?? {
        linesAdded: 12, linesRemoved: 5, linesNet: 7,
        byTool: { Edit: 2, Write: 1, MultiEdit: 0 }, editCount: 3,
      },
    });

    it('publishes a trimmed codeOutput (no byDay/byProject) with the pinned shape', async () => {
      const snap = await build([withCode(), withCode()]);
      assert.deepEqual(Object.keys(snap.codeOutput).sort(), [
        'byTool', 'linesAdded', 'linesNet', 'linesRemoved', 'timeSpentMs',
      ]);
      assert.equal(snap.codeOutput.linesAdded, 24);
      assert.equal(snap.codeOutput.linesRemoved, 10);
      assert.equal(snap.codeOutput.linesNet, 14);
      assert.equal(snap.codeOutput.timeSpentMs, 120_000);
      assert.deepEqual(snap.codeOutput.byTool, { Edit: 4, Write: 2, MultiEdit: 0 });
      assert.equal(snap.codeOutput.byDay, undefined, 'byDay dropped for the phone');
      assert.equal(snap.codeOutput.byProject, undefined, 'byProject dropped for the phone');
    });

    it('keeps schemaVersion at 1 (codeOutput is an additive optional key)', async () => {
      const snap = await build([withCode()]);
      assert.equal(snap.schemaVersion, 1);
      assert.ok('codeOutput' in snap);
    });

    it('emits all-zero numbers (never null) when no session has codeOutput', async () => {
      const snap = await build([makeSession()]); // makeSession() has no codeOutput
      assert.deepEqual(snap.codeOutput, {
        linesAdded: 0, linesRemoved: 0, linesNet: 0, timeSpentMs: 0,
        byTool: { Edit: 0, Write: 0, MultiEdit: 0 },
      });
    });
  });
  ```

- [ ] **Step 2: Run the test — verify it FAILS.**
  Command: `node --test test/snapshot.test.js`
  Expected: the new block fails (`snap.codeOutput` is `undefined`); existing snapshot tests still pass.

- [ ] **Step 3: Implement in `lib/snapshot.js`.**

  3a. Import (anchor: after `import { rollupByProject, rollupByDay } from './aggregator.js';`, `snapshot.js:20`):
  ```js
  import { aggregateCodeOutput } from './code-output.js';
  ```

  3b. Add a trim helper (anchor: after the `buildDaily` function, `snapshot.js:229`):
  ```js
  /**
   * Trimmed code-output totals for the phone (Code Insights Phase 1). Reuses the
   * shared aggregator (no drift with /api/code-output), then drops byDay/byProject
   * to keep the payload small. All fields are numbers (never null — review #26).
   */
  function buildCodeOutput(sessions) {
    const a = aggregateCodeOutput(sessions);
    return {
      linesAdded: a.linesAdded,
      linesRemoved: a.linesRemoved,
      linesNet: a.linesNet,
      timeSpentMs: a.timeSpentMs,
      byTool: a.byTool,
    };
  }
  ```

  3c. Add the key to the returned snapshot object (anchor: inside the `return {…}` of `buildSnapshot`, immediately after the `forecast: { weekOverWeek, roiPace },` line, `snapshot.js:318` — additive optional key, schemaVersion untouched):
  ```js
      // Code Insights Phase 1 (optional, schemaVersion STAYS 1): lines written +
      // time spent over the same period-filtered sessions. Old iOS ignores it.
      codeOutput: buildCodeOutput(sessions),
  ```

- [ ] **Step 4: Run the test — verify it PASSES.**
  Command: `node --test test/snapshot.test.js`
  Expected: all pass, including existing snapshot tests.

- [ ] **Step 5: Full gate + commit.**
  ```bash
  npm run build:sidecar && npm run check
  git add lib/snapshot.js test/snapshot.test.js
  git commit -m "feat(code-insights): publish optional codeOutput snapshot key (schemaVersion stays 1)"
  ```
  PR: `gh pr create` → `gh pr checks --watch` → (approval) → `gh pr merge --squash`.

---

## PR 4 — `feat/code-output-dashboard` (Task 5, after PR 2 merges)

> **Precondition (on `main`):** `GET /api/code-output` (PR 2). This PR adds the "Code Output" section to the Overview panel: headline numbers (added / removed / net / time spent) rendered SURGICALLY via `setTextIfChanged` (landmine #22), plus per-tool and per-project breakdown lists via `innerHTML` exactly like `renderToolLists`. It fetches `/api/code-output` in the existing `refreshAll()` `Promise.all`, wires an empty state for new/light installs (review #09 — no scary zeros/negatives), and adds minimal CSS reusing existing tokens/classes. **No new served JS file → no SEA manifest edit (landmine #2/#39).**

---

### Task 5: "Code Output" dashboard section

**Files**
- Modify: `/Users/adnanrashid/Projects/clauge/public/index.html` (markup — new row at the end of the Overview panel).
- Modify: `/Users/adnanrashid/Projects/clauge/public/app.js` (state slot, `fmtDuration` helper, `api('/api/code-output')` in `refreshAll`, `renderCodeOutput()`).
- Modify: `/Users/adnanrashid/Projects/clauge/public/styles.css` (a few classes; reuse existing `glass`/`card`/`tool-row`/`bar-*`).

**Interfaces**
- **Consumes:** `GET /api/code-output?period=` (PR 2); the existing `state`, `refreshAll()`, `setTextIfChanged`, `escapeHtml`, `fmtInt` in `public/app.js`.
- **Produces:** rendered DOM under `#code-output` (headline `#co-lines-added` / `#co-lines-removed` / `#co-lines-net` / `#co-time-spent`; `#co-tools`; `#co-projects`; `#co-empty` empty-state).

> **Verification note (house rule 3 — UI changes need a real surface):** unit assertions do not exercise a rendered DOM. After Step 5 passes, do a real-surface check: launch the dashboard (`NO_OPEN=1 node server.js` against a real `~/.claude`, or `cargo tauri dev`), open the Overview tab, confirm the Code Output card shows numbers (or the empty state on a light install), switch the period selector and confirm the numbers change, and let one 60s auto-refresh tick pass with no visible flicker. Optionally `/visual-verify` the section. Record the result in the PR description.

**Steps**

- [ ] **Step 1: Write the failing render-unit test `test/dashboard-code-output.test.js`.** `renderCodeOutput` reads `state.data.codeOutput` and writes into a DOM. Since `public/app.js` is a browser module (not import-safe under `node:test` without a DOM), test the **pure formatter + empty-state predicate** you will extract, not the whole render. Add a tiny pure helper module so the logic is testable headless. Create `lib/code-output-format.js` is NOT wanted (that's a served concern) — instead keep the formatter inside `app.js` and unit-test only `fmtDuration` via a **plain assertion script**. Concretely, this task's automated coverage is the formatter; the section render is covered by the real-surface check in the Verification note above.

  Create `test/code-output-format.test.js`:
  ```js
  // Pure formatter used by the dashboard Code Output section. Kept in a tiny
  // shared module so it is unit-testable headless (public/app.js is a browser
  // module). Only the ms→"Hh Mm" formatting logic lives here.
  import { describe, it } from 'node:test';
  import assert from 'node:assert/strict';
  import { fmtDurationMs } from '../lib/code-output-format.js';

  describe('fmtDurationMs', () => {
    it('formats hours and minutes', () => {
      assert.equal(fmtDurationMs(0), '0m');
      assert.equal(fmtDurationMs(300000), '5m'); // 5 min
      assert.equal(fmtDurationMs(3_600_000), '1h 0m');
      assert.equal(fmtDurationMs(5_400_000), '1h 30m');
    });
    it('guards non-finite input to a dash', () => {
      assert.equal(fmtDurationMs(null), '—');
      assert.equal(fmtDurationMs(NaN), '—');
      assert.equal(fmtDurationMs(-1), '—');
    });
  });
  ```

- [ ] **Step 2: Run the test — verify it FAILS.**
  Command: `node --test test/code-output-format.test.js`
  Expected: `Cannot find module '../lib/code-output-format.js'`.

- [ ] **Step 3: Create the shared formatter `lib/code-output-format.js`.** Pure, no `console.log`. It is imported by BOTH the test and `public/app.js` (served — but it lives in `lib/`, which is already bundled; it is NOT a new `public/*.js` file, so no SEA manifest change). Complete file:
  ```js
  /**
   * Duration formatter for the dashboard Code Output section (Code Insights
   * Phase 1). Pure; ms → "Hh Mm" (or "Mm" under an hour). Non-finite/negative
   * → em-dash. Shared between public/app.js and its unit test.
   */
  export function fmtDurationMs(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  ```

- [ ] **Step 4: Run the test — verify it PASSES.**
  Command: `node --test test/code-output-format.test.js`
  Expected: all pass.

- [ ] **Step 5: Add the section markup to `public/index.html`.** Anchor: immediately before the closing `</section>` of `<section data-panel="overview">` (the panel opens at `index.html:70` and closes just before `<section data-panel="sessions" hidden>` at `index.html:231` — insert the block right before that closing `</section>`):
  ```html
  <!-- ═══════════════════════ CODE OUTPUT (Code Insights Phase 1) ═══════════ -->
  <div class="glass card" id="code-output" style="margin-top:24px">
    <div class="card-head">
      <div class="card-title-row">
        <h3 class="card-title">Code output</h3>
        <span class="card-sub">lines Claude wrote via tools</span>
      </div>
    </div>
    <div id="co-empty" class="empty" hidden>
      No code written in this period yet. As Claude edits and writes files, your
      lines and time will show up here.
    </div>
    <div id="co-body">
      <div class="co-metrics">
        <div class="co-metric"><span class="co-val" id="co-lines-added">—</span><span class="co-label">lines added</span></div>
        <div class="co-metric"><span class="co-val" id="co-lines-removed">—</span><span class="co-label">lines removed</span></div>
        <div class="co-metric"><span class="co-val" id="co-lines-net">—</span><span class="co-label">net lines</span></div>
        <div class="co-metric"><span class="co-val" id="co-time-spent">—</span><span class="co-label">time in Claude Code</span></div>
      </div>
      <div class="row row-2" style="margin-top:16px">
        <div>
          <div class="card-title-row"><h4 class="card-title">By tool</h4></div>
          <div id="co-tools"></div>
        </div>
        <div>
          <div class="card-title-row"><h4 class="card-title">By project</h4></div>
          <div id="co-projects"></div>
        </div>
      </div>
    </div>
  </div>
  ```

- [ ] **Step 6: Wire `public/app.js`.**

  6a. Add the state slot (anchor: inside `state.data`, after `projection: null,` — `app.js:28`):
  ```js
      codeOutput: null,
  ```

  6b. Import the shared formatter at the TOP of the module (anchor: `app.js` is `type="module"`; add near the top, e.g. after the header comment block, before `const state`):
  ```js
  import { fmtDurationMs } from '/code-output-format.js';
  ```
  > NOTE: `public/app.js` cannot import from `lib/` over HTTP (the server only serves `public/`). So the formatter must be reachable at a served path. **Two options — pick ONE and keep the test import consistent:**
  > - **(a)** Put the formatter at `public/code-output-format.js` (served) AND add it to BOTH SEA manifests (`sea-config.json` + `sea-bootstrap.cjs` ASSETS — landmine #2/#39), then import it in the test via a relative path `../public/code-output-format.js`. This makes it a NEW served JS file → manifest edit REQUIRED.
  > - **(b)** Inline `fmtDurationMs` directly in `app.js` (no new file, no manifest edit) and unit-test a copy in `lib/code-output-format.js`. Simpler but duplicates ~6 lines.
  >
  > **Recommended: option (a)** — one source of truth, and add the manifest entry. Update Step 3 to create `public/code-output-format.js` (not `lib/`), update the test import to `../public/code-output-format.js`, and add a Step 6c manifest edit. If you prefer no manifest churn, take option (b) and drop the import line above.

  6c. **(Only if option (a))** Add `public/code-output-format.js` to BOTH SEA manifests. Edit `sea-config.json` (add the path to its assets map) and `sea-bootstrap.cjs` (add it to the `ASSETS` array). Rebuild with `npm run build:sidecar` and confirm `node scripts/validate-html-facade-loads.cjs` + the SEA smoke still pass. (This is the landmine #2/#39 mirror — a served asset missing from either manifest 404s silently in the packaged app.)

  6d. Fetch `/api/code-output` in `refreshAll()`. Add to the `Promise.all` array (anchor: after `api('/api/projection').catch(() => null),` — `app.js:1425`):
  ```js
        api('/api/code-output', commonParams()).catch(() => null),
  ```
  Extend the destructure (anchor: the `const [health, …, projection] = await Promise.all([` line — `app.js:1406`) to add `, codeOutput` at the end:
  ```js
      const [health, summary, cache, sessions, daily, hours, projects, activity, tools, models, usage, expensive, roi, projection, codeOutput] =
  ```
  Add it to the `state.data = {…}` assignment (anchor: `app.js:1428-1431`), keep-last-good like `projection`:
  ```js
        projection: projection ?? state.data.projection,
        codeOutput: codeOutput ?? state.data.codeOutput,
  ```
  Call the renderer in the render list (anchor: after `renderToolLists();` — `app.js:1446`):
  ```js
      renderCodeOutput();
  ```

  6e. Add the renderer. Place it next to `renderToolLists` (anchor: after the `renderToolLists` function closes, `app.js:933`):
  ```js
  // Code Insights Phase 1. Headline numbers update SURGICALLY (setTextIfChanged)
  // so a 60s tick with unchanged data churns no nodes (landmine #22). The two
  // breakdown lists use innerHTML — same as renderToolLists; they carry no
  // running CSS animation, so a full rebuild is safe. Empty state for light
  // installs: no scary zeros/negatives (review #09).
  function renderCodeOutput() {
    const d = state.data.codeOutput;
    const byTool = d?.byTool ?? { Edit: 0, Write: 0, MultiEdit: 0 };
    const editCalls = byTool.Edit + byTool.Write + byTool.MultiEdit;
    const hasData = editCalls > 0 || (d?.timeSpentMs ?? 0) > 0;

    const empty = document.getElementById('co-empty');
    const body = document.getElementById('co-body');
    if (empty) empty.hidden = hasData;
    if (body) body.hidden = !hasData;
    if (!hasData) return;

    setTextIfChanged(document.getElementById('co-lines-added'), fmtInt(d.linesAdded));
    setTextIfChanged(document.getElementById('co-lines-removed'), fmtInt(d.linesRemoved));
    setTextIfChanged(document.getElementById('co-lines-net'), fmtInt(d.linesNet));
    setTextIfChanged(document.getElementById('co-time-spent'), fmtDurationMs(d.timeSpentMs));

    // By tool (invocation counts).
    const toolItems = [
      { name: 'Edit', count: byTool.Edit },
      { name: 'Write', count: byTool.Write },
      { name: 'MultiEdit', count: byTool.MultiEdit },
    ].filter((x) => x.count > 0);
    const toolsWrap = document.getElementById('co-tools');
    if (toolsWrap) {
      const max = Math.max(...toolItems.map((x) => x.count), 1);
      toolsWrap.innerHTML = toolItems.length
        ? toolItems.map((x) => {
            const pct = (x.count / max) * 100;
            return `<div class="tool-row">
              <span class="tool-name">${escapeHtml(x.name)}</span>
              <div class="bar-track" style="height:4px"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
              <span class="tool-count">${escapeHtml(fmtInt(x.count))}</span>
            </div>`;
          }).join('')
        : '<div class="empty">none</div>';
    }

    // By project (top 8 by net lines).
    const projWrap = document.getElementById('co-projects');
    if (projWrap) {
      const projects = (d.byProject ?? []).slice(0, 8);
      const maxNet = Math.max(...projects.map((p) => Math.abs(p.linesNet)), 1);
      projWrap.innerHTML = projects.length
        ? projects.map((p) => {
            const pct = (Math.abs(p.linesNet) / maxNet) * 100;
            return `<div class="tool-row">
              <span class="tool-name">${escapeHtml(p.project)}</span>
              <div class="bar-track" style="height:4px"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
              <span class="tool-count">${escapeHtml(fmtInt(p.linesNet))}</span>
            </div>`;
          }).join('')
        : '<div class="empty">none</div>';
    }
  }
  ```

- [ ] **Step 7: Add CSS to `public/styles.css`.** Append (reuses existing tokens; check the real var names in `styles.css` — e.g. `--text-2`/`--text-3` used by app.js — and match them; below uses the same muted-label pattern as existing `.card-sub`):
  ```css
  /* Code Output section (Code Insights Phase 1). */
  .co-metrics {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
  }
  @media (max-width: 640px) {
    .co-metrics { grid-template-columns: repeat(2, 1fr); }
  }
  .co-metric { display: flex; flex-direction: column; gap: 4px; }
  .co-val { font-size: 1.5rem; font-weight: 700; line-height: 1.1; }
  .co-label { font-size: 0.75rem; color: var(--text-3); }
  ```

- [ ] **Step 8: Run the formatter test + full gate.**
  Command: `node --test test/code-output-format.test.js`
  Then: `npm run build:sidecar && npm run check`
  Expected: all green.

- [ ] **Step 9: Real-surface verification (house rule 3).** Launch the dashboard and confirm: numbers render on Overview (or empty state on a light install), the period selector changes them, and one 60s auto-refresh tick passes with no flicker in the Code Output card. Record the check in the PR body. (If you added `public/code-output-format.js` per option (a), also confirm the packaged SEA sidecar serves it — run the SEA smoke.)

- [ ] **Step 10: Commit.**
  ```bash
  git add public/index.html public/app.js public/styles.css test/code-output-format.test.js public/code-output-format.js sea-config.json sea-bootstrap.cjs
  git commit -m "feat(code-insights): Code Output dashboard section (surgical headline + breakdowns)"
  ```
  (Drop `public/code-output-format.js` + the two manifest files from the `git add` if you took option (b) and inlined `fmtDurationMs` instead.)
  PR: `gh pr create` → `gh pr checks --watch` → (approval + real-surface check noted) → `gh pr merge --squash`.

---

## Phase 1 done-when

- `session.codeOutput` present on every summary; `GET /api/code-output?period=` returns the pinned shape; the Overview "Code Output" section renders (with an empty state on light installs); `snapshot.codeOutput` published with `schemaVersion` still `1`.
- All four PRs merged via squash after a green `npm run build:sidecar && npm run check` and per-PR approval.
- The pinned contract names (`session.codeOutput`, `GET /api/code-output` response, snapshot `codeOutput`) are exactly as written above — Phases 2–4 bind to them.

---

# Phase 2 — Git Value (opt-in, read-only git) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Value** panel to the desktop Code Insights area that answers "how many commits landed while a Claude Code session was live in this repo, how many lines they added, and what did each cost?" — an honest **correlation, never a per-line attribution**. It reads git **read-only**, is **opt-in** behind a new `gitValueEnabled` config flag (default OFF), and never mutates git. When enabled the Mac also publishes a `gitValue` key into the iPhone snapshot (additive; schemaVersion stays 1).

**Architecture:** A new pure module `lib/git-value.js` does all the correlation math and constructs the git argv, but performs **no I/O itself** — the single side effect (spawning read-only git) goes through an **injected `run` seam** `(args, cwd) => Promise<{stdout, ok}>`, so unit tests drive it with canned `git log` output and never touch a real repo. The production seam (`execFile('git', …)`) lives at the I/O boundary in `server.js`. A new `GET /api/git-value` calls the module with the default seam; `POST /api/config/git-value` flips the flag (mirrors `POST /api/config/alerts`). `lib/snapshot.js` gains an optional `gitValue` key. The dashboard adds a Value panel with an opt-in toggle and a coached empty state.

**Spec (authoritative):** `docs/superpowers/specs/2026-07-10-code-insights-design.md` (§ Components → `lib/git-value.js`; § Phasing → Phase 2; § Risks/landmines).

**Consumes from Phase 1 (already on `main` when this runs):** `session.codeOutput` exists; the dashboard **Code Insights** area exists (this plan adds the Value panel into it). Phase 2 does **not** depend on `codeOutput` at runtime — only on the Code Insights DOM container being present for the Value panel to slot into.

**House rules in force (bake into every task):** ESM (`"type":"module"`); `lib/` modules pure with the clock injected (`nowMs` always a param — never `Date.now()` inside `lib/`); the git spawn is the **only** I/O and goes through the injected `run` seam so `lib/` stays testable; **no `console.log` in `lib/`**; JS tests live at `test/<name>.test.js` and run with `node --test <file>` (landmine #14 — NOT a new dir; landmine #38 — dual-mode browser helpers are IIFE + `window` + `vm`, not CommonJS); **no new dependencies**; Conventional Commits (no `Co-Authored-By`); full gate `npm run check` before every merge (landmine #29 — validators are a subset; the gate is the whole command); branch → PR → `gh pr checks --watch` → `gh pr merge --squash`, **never** direct to `main`. **Security is first-class** here (we spawn a subprocess) — a dedicated test proves no mutating git subcommand can ever be built and that a hostile cwd/args can't inject flags.

---

## PR / branch structure

| PR | Branch | Tasks | Contents |
|---|---|---|---|
| 1 | `feat/git-value-engine` | 1 | `lib/git-value.js` (pure; injected `run` seam; read-only allowlist) + `test/git-value.test.js` (canned-output correlation + security/allowlist) + AGENTS.md landmine #45 |
| 2 | `feat/git-value-wiring` | 2–4 | `config-store` `gitValueEnabled` (read-merge-write, default FALSE) + `GET /api/git-value` + `POST /api/config/git-value` + `GET /api/config` extension + `/api/git-value` in `READ_ONLY_API_PATHS` + default `gitRun` seam; snapshot optional `gitValue` key; server + snapshot tests |
| 3 | `feat/git-value-dashboard` | 5–6 | `public/swr.js` `gitValueView` (pure, vm-tested) + dashboard Value panel (`index.html` + `styles.css` + `app.js` `renderGitValue`/`initGitValueControls` + `refreshAll` wiring) |

Each PR: branch from fresh `main` after the previous merges → run the FULL gate `npm run check` locally (needs `npm run build:sidecar` if a served asset changed — PR 3 does **not** add a served file, so `test:sea` stays dormant; see landmine #39) → `gh pr create` → `gh pr checks --watch` (branch protection requires `check`; auto-merge NOT enabled — never merge right after create) → `gh pr merge --squash`.

**Sequencing:** PR 2 depends on PR 1 (`correlateCommits`). PR 3 depends on PR 2 (`GET /api/git-value`, `POST /api/config/git-value`, `gitValueEnabled` reported by `GET /api/config`). Tasks within a PR are sequential.

---

## Pinned contracts (Phase 3 + iOS Phase 4 depend on these EXACT names — do not deviate)

- **Config flag:** `gitValueEnabled` (a top-level boolean key in `~/.clauge/config.json`, default **false**). Store methods: `effectiveGitValueEnabled() → boolean` · `setGitValueEnabled(enabled) → { enabled }`.
- **Module:** `correlateCommits({ sessions, nowMs, run }) → { commits, linesCommitted, costPerCommit, byProject: [{ project, commits, linesCommitted }], commitsWithSession }`. `run` is `(args: string[], cwd: string) => Promise<{ stdout: string, ok: boolean }>`. Also exports `ALLOWED_GIT_SUBCOMMANDS` and `assertReadOnlyGitArgs(args)`.
- **Route:** `GET /api/git-value?period=` → `{ enabled: false }` when off, else `{ enabled: true, commits, linesCommitted, costPerCommit, byProject }`. `POST /api/config/git-value` `{ enabled: boolean }` → `{ enabled }` (400 on non-boolean / non-JSON).
- **Snapshot key:** `gitValue` — a top-level OPTIONAL key present **only when enabled**; object `{ commits, linesCommitted, costPerCommit, byProject }` (all numbers/array, **never bare null** — review #26). `SNAPSHOT_SCHEMA_VERSION` **STAYS 1** (landmine #37).

**Semantic decisions pinned here (resolve the spec's ambiguity so Phase 3/iOS are unambiguous):**
1. **`commits` = commits-during-sessions** (the headline). We fetch git commits in the coarse union window, then keep ONLY those whose **author timestamp** falls inside an actual session window. Every kept commit is "with a session" by construction, so **`commitsWithSession === commits`** — the two names are the same measured quantity (`commits` is the wire/route name; `commitsWithSession` is the self-documenting name). Commits that landed in a gap between sessions are discarded (correlation, not attribution).
2. **Git target is `session.cwd`, NOT `session.project`.** `resolveProjectName` (`lib/parser.js:154`) reduces `project` to the **basename** (e.g. `clauge`); the real repo path is `session.cwd`. We group sessions by `session.cwd` (the git `-C` target) and label `byProject[].project` with the friendly `session.project` name. Sessions with no `cwd` are skipped.
3. **`linesCommitted` = added lines** summed over correlated commits (numstat column 1; binary `-` contributes 0). `removed` is parsed but not surfaced (YAGNI).
4. **`costPerCommit` = `sumSessionCosts(sessions) / commits`, 0-guarded to `0`** when `commits === 0` (never `null` — keeps the snapshot free of bare-null typed slots). Cost is in **dollars** (`session.cost` is dollars).

---

## PR 1 — `feat/git-value-engine` (Task 1)

> One pure ESM module + its tests. The engine constructs the git argv and does the correlation math; the ONLY side effect (read-only git spawn) is delegated to an injected `run` seam. Security is first-class: a dedicated test proves the allowlist and that the repo path never reaches the argv. No new dependencies. No `console.*` anywhere in the module.

### Task 1: `lib/git-value.js` — pure read-only git↔session correlation + canned-output & security tests

**Files**
- Create: `/Users/adnanrashid/Projects/clauge/lib/git-value.js`
- Test: `/Users/adnanrashid/Projects/clauge/test/git-value.test.js`
- Modify: `/Users/adnanrashid/Projects/clauge/AGENTS.md` (add landmine #45)

**Interfaces (this module)**
```text
export const ALLOWED_GIT_SUBCOMMANDS: readonly ['log', 'rev-parse']
export function assertReadOnlyGitArgs(args: string[]): void   // throws unless args[0] ∈ allowlist
export async function correlateCommits({
  sessions: Array<{ cwd?, project?, startedAt?, endedAt?, cost? }>,
  nowMs: number,
  run: (args: string[], cwd: string) => Promise<{ stdout: string, ok: boolean }>,
}): Promise<{
  commits: number,
  linesCommitted: number,
  costPerCommit: number,
  byProject: Array<{ project: string, commits: number, linesCommitted: number }>,
  commitsWithSession: number,   // === commits (see pinned decision #1)
}>
```
Depends on: `sumSessionCosts` from `./roi-calculator.js` (pure). No other imports.

**Steps**

- [ ] **Step 1: Write the failing test file `test/git-value.test.js`.** Complete file — canned `run` (no real git) for correlation + a spy `run` for the security proof:

  ```js
  // Unit tests for lib/git-value.js — read-only git ↔ session correlation
  // (Code Insights Phase 2, docs/superpowers/specs/2026-07-10-code-insights-design.md).
  //
  // The module performs NO real I/O: the git spawn goes through an INJECTED
  // `run` seam. These tests drive it with canned `git log --numstat` output and,
  // for the security proof, a spy seam that records every argv+cwd — so we can
  // assert the read-only allowlist holds and that the repo path is NEVER placed
  // on the git argv (it is only ever the seam's cwd). No real repo is touched.

  import { describe, it } from 'node:test';
  import assert from 'node:assert/strict';
  import {
    correlateCommits,
    assertReadOnlyGitArgs,
    ALLOWED_GIT_SUBCOMMANDS,
  } from '../lib/git-value.js';

  // 2026-07-10T12:00:00.000Z — the injected clock. All session windows below
  // are in the PAST relative to this, except the explicit clamp test.
  const NOW_MS = Date.parse('2026-07-10T12:00:00.000Z');

  const RS = '\x1e';
  const US = '\x1f';

  // Build canned `git log --numstat --format=<RS>%H<US>%at` stdout.
  // commits: [{ hash, atSec, files: [[added, removed, path], ...] }]
  function gitLog(commits) {
    return (
      commits
        .map(
          (c) =>
            `${RS}${c.hash}${US}${c.atSec}\n` +
            c.files.map(([a, r, p]) => `${a}\t${r}\t${p}`).join('\n'),
        )
        .join('\n') + '\n'
    );
  }

  // Author-time helper: seconds since epoch for an ISO string.
  const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

  // A canned seam: rev-parse → {ok:true, stdout:'true'} for repos in `repos`,
  // {ok:false} otherwise; log → the canned output keyed by cwd.
  function cannedRun({ repos = new Set(), logByCwd = {} }) {
    return async (args, cwd) => {
      if (args[0] === 'rev-parse') {
        return repos.has(cwd) ? { stdout: 'true\n', ok: true } : { stdout: '', ok: false };
      }
      if (args[0] === 'log') {
        const out = logByCwd[cwd];
        return out == null ? { stdout: '', ok: false } : { stdout: out, ok: true };
      }
      return { stdout: '', ok: false };
    };
  }

  // A spy seam that records every call and delegates to an inner responder.
  function spyRun(inner) {
    const calls = [];
    const run = async (args, cwd) => {
      calls.push({ args: [...args], cwd });
      return inner(args, cwd);
    };
    run.calls = calls;
    return run;
  }

  const session = (o) => ({
    cwd: o.cwd,
    project: o.project ?? o.cwd.split('/').pop(),
    startedAt: o.startedAt,
    endedAt: o.endedAt,
    cost: o.cost ?? 0,
  });

  describe('exports — pinned contract', () => {
    it('ALLOWED_GIT_SUBCOMMANDS is exactly {log, rev-parse}', () => {
      assert.deepEqual([...ALLOWED_GIT_SUBCOMMANDS].sort(), ['log', 'rev-parse']);
    });
  });

  describe('correlateCommits — happy path', () => {
    it('counts only commits whose author-time is inside a session window', async () => {
      const cwd = '/Users/a/Projects/clauge';
      const sessions = [
        session({
          cwd,
          startedAt: '2026-07-09T10:00:00Z',
          endedAt: '2026-07-09T11:00:00Z',
          cost: 3,
        }),
        session({
          cwd,
          startedAt: '2026-07-09T14:00:00Z',
          endedAt: '2026-07-09T15:00:00Z',
          cost: 5,
        }),
      ];
      const run = cannedRun({
        repos: new Set([cwd]),
        logByCwd: {
          [cwd]: gitLog([
            // inside window 1 → counts, +10 lines
            { hash: 'aaa', atSec: sec('2026-07-09T10:30:00Z'), files: [['7', '2', 'a.js'], ['3', '0', 'b.js']] },
            // in the GAP between windows → discarded
            { hash: 'bbb', atSec: sec('2026-07-09T12:00:00Z'), files: [['99', '0', 'c.js']] },
            // inside window 2 → counts, +4 lines
            { hash: 'ccc', atSec: sec('2026-07-09T14:30:00Z'), files: [['4', '1', 'd.js']] },
          ]),
        },
      });

      const res = await correlateCommits({ sessions, nowMs: NOW_MS, run });
      assert.equal(res.commits, 2, 'gap commit excluded');
      assert.equal(res.commitsWithSession, 2, 'alias equals commits by construction');
      assert.equal(res.linesCommitted, 14, '10 + 4 added lines (removed ignored)');
      // costPerCommit = sum session cost / commits = (3+5)/2 = 4
      assert.equal(res.costPerCommit, 4);
      assert.deepEqual(res.byProject, [{ project: 'clauge', commits: 2, linesCommitted: 14 }]);
    });

    it('binary numstat rows (-) contribute 0 lines but still count the commit', async () => {
      const cwd = '/repo/x';
      const sessions = [session({ cwd, startedAt: '2026-07-08T00:00:00Z', endedAt: '2026-07-08T01:00:00Z', cost: 2 })];
      const run = cannedRun({
        repos: new Set([cwd]),
        logByCwd: {
          [cwd]: gitLog([
            { hash: 'bin', atSec: sec('2026-07-08T00:30:00Z'), files: [['-', '-', 'img.png'], ['5', '0', 'z.js']] },
          ]),
        },
      });
      const res = await correlateCommits({ sessions, nowMs: NOW_MS, run });
      assert.equal(res.commits, 1);
      assert.equal(res.linesCommitted, 5, 'binary - counts as 0');
    });

    it('aggregates multiple repos and sorts byProject by commits desc', async () => {
      const c1 = '/repo/one';
      const c2 = '/repo/two';
      const sessions = [
        session({ cwd: c1, startedAt: '2026-07-07T10:00:00Z', endedAt: '2026-07-07T12:00:00Z', cost: 4 }),
        session({ cwd: c2, startedAt: '2026-07-07T10:00:00Z', endedAt: '2026-07-07T12:00:00Z', cost: 6 }),
      ];
      const run = cannedRun({
        repos: new Set([c1, c2]),
        logByCwd: {
          [c1]: gitLog([{ hash: 'p', atSec: sec('2026-07-07T11:00:00Z'), files: [['1', '0', 'a']] }]),
          [c2]: gitLog([
            { hash: 'q', atSec: sec('2026-07-07T11:00:00Z'), files: [['2', '0', 'b']] },
            { hash: 'r', atSec: sec('2026-07-07T11:30:00Z'), files: [['3', '0', 'c']] },
          ]),
        },
      });
      const res = await correlateCommits({ sessions, nowMs: NOW_MS, run });
      assert.equal(res.commits, 3);
      assert.equal(res.linesCommitted, 6);
      assert.equal(res.costPerCommit, (4 + 6) / 3);
      assert.deepEqual(res.byProject.map((p) => p.project), ['two', 'one'], 'sorted by commits desc');
    });
  });

  describe('correlateCommits — graceful degradation (never throws)', () => {
    it('a non-repo cwd (rev-parse !ok) contributes nothing', async () => {
      const cwd = '/not/a/repo';
      const sessions = [session({ cwd, startedAt: '2026-07-09T10:00:00Z', endedAt: '2026-07-09T11:00:00Z', cost: 9 })];
      const run = cannedRun({ repos: new Set(), logByCwd: {} }); // rev-parse !ok
      const res = await correlateCommits({ sessions, nowMs: NOW_MS, run });
      assert.deepEqual(res, {
        commits: 0,
        linesCommitted: 0,
        costPerCommit: 0,
        byProject: [],
        commitsWithSession: 0,
      });
    });

    it('a git-error on log (!ok) skips that repo without throwing', async () => {
      const cwd = '/repo/err';
      const sessions = [session({ cwd, startedAt: '2026-07-09T10:00:00Z', endedAt: '2026-07-09T11:00:00Z', cost: 1 })];
      // rev-parse ok, but no log output registered → log returns !ok
      const run = cannedRun({ repos: new Set([cwd]), logByCwd: {} });
      const res = await correlateCommits({ sessions, nowMs: NOW_MS, run });
      assert.equal(res.commits, 0);
      assert.equal(res.byProject.length, 0);
    });

    it('a seam that THROWS is caught per-repo (one bad repo never sinks the rest)', async () => {
      const good = '/repo/good';
      const bad = '/repo/bad';
      const sessions = [
        session({ cwd: good, startedAt: '2026-07-09T10:00:00Z', endedAt: '2026-07-09T11:00:00Z', cost: 2 }),
        session({ cwd: bad, startedAt: '2026-07-09T10:00:00Z', endedAt: '2026-07-09T11:00:00Z', cost: 2 }),
      ];
      const run = async (args, cwd) => {
        if (cwd === bad) throw new Error('spawn EACCES');
        if (args[0] === 'rev-parse') return { stdout: 'true\n', ok: true };
        return { stdout: gitLog([{ hash: 'g', atSec: sec('2026-07-09T10:30:00Z'), files: [['1', '0', 'a']] }]), ok: true };
      };
      const res = await correlateCommits({ sessions, nowMs: NOW_MS, run });
      assert.equal(res.commits, 1, 'good repo still counted');
    });

    it('sessions with no cwd are skipped', async () => {
      const sessions = [{ project: 'x', startedAt: '2026-07-09T10:00:00Z', endedAt: '2026-07-09T11:00:00Z', cost: 5 }];
      const run = cannedRun({ repos: new Set(), logByCwd: {} });
      const res = await correlateCommits({ sessions, nowMs: NOW_MS, run });
      assert.equal(res.commits, 0);
    });

    it('missing run / empty sessions → all-zero result', async () => {
      const empty = { commits: 0, linesCommitted: 0, costPerCommit: 0, byProject: [], commitsWithSession: 0 };
      assert.deepEqual(await correlateCommits({ sessions: [], nowMs: NOW_MS, run: () => {} }), empty);
      assert.deepEqual(await correlateCommits({ sessions: [session({ cwd: '/r', startedAt: '2026-07-09T10:00:00Z', endedAt: '2026-07-09T11:00:00Z' })], nowMs: NOW_MS, run: undefined }), empty);
    });
  });

  describe('correlateCommits — clock (nowMs) clamps future ends', () => {
    it('a commit AFTER nowMs is not counted even inside a session whose end is in the future', async () => {
      const cwd = '/repo/clock';
      // session end is 2h in the FUTURE; nowMs clamps the effective window to now.
      const sessions = [
        session({
          cwd,
          startedAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString(), // 1h ago
          endedAt: new Date(NOW_MS + 2 * 60 * 60 * 1000).toISOString(), // 2h ahead
          cost: 4,
        }),
      ];
      const run = cannedRun({
        repos: new Set([cwd]),
        logByCwd: {
          [cwd]: gitLog([
            { hash: 'past', atSec: Math.floor((NOW_MS - 30 * 60 * 1000) / 1000), files: [['2', '0', 'a']] }, // 30m ago → counts
            { hash: 'future', atSec: Math.floor((NOW_MS + 60 * 60 * 1000) / 1000), files: [['9', '0', 'b']] }, // 1h ahead → clamped out
          ]),
        },
      });
      const res = await correlateCommits({ sessions, nowMs: NOW_MS, run });
      assert.equal(res.commits, 1, 'future commit excluded by the nowMs clamp');
      assert.equal(res.linesCommitted, 2);
    });
  });

  // ── SECURITY (first-class — we spawn a subprocess) ──────────────────────────
  describe('assertReadOnlyGitArgs — allowlist guard', () => {
    it('accepts the two read-only subcommands', () => {
      assert.doesNotThrow(() => assertReadOnlyGitArgs(['log', '--numstat']));
      assert.doesNotThrow(() => assertReadOnlyGitArgs(['rev-parse', '--is-inside-work-tree']));
    });

    it('throws on every mutating / unknown subcommand', () => {
      for (const bad of ['commit', 'checkout', 'reset', 'push', 'pull', 'clean', 'rebase', 'merge', 'add', 'rm', 'fetch', 'apply', 'config', '', undefined]) {
        assert.throws(() => assertReadOnlyGitArgs([bad, '--anything']), /non-allowlisted|empty args/);
      }
    });

    it('throws on empty args', () => {
      assert.throws(() => assertReadOnlyGitArgs([]), /empty args/);
    });
  });

  describe('security — the repo path is NEVER on the git argv, and no mutating verb is ever built', () => {
    it('every seam call is allowlisted, path-free, and rev-parse precedes log', async () => {
      const cwd = '/Users/a/Projects/clauge';
      const sessions = [session({ cwd, startedAt: '2026-07-09T10:00:00Z', endedAt: '2026-07-09T11:00:00Z', cost: 1 })];
      const run = spyRun((args) => {
        if (args[0] === 'rev-parse') return Promise.resolve({ stdout: 'true\n', ok: true });
        return Promise.resolve({ stdout: gitLog([{ hash: 'h', atSec: sec('2026-07-09T10:30:00Z'), files: [['1', '0', 'a']] }]), ok: true });
      });

      await correlateCommits({ sessions, nowMs: NOW_MS, run });

      const MUTATING = ['commit', 'checkout', 'reset', 'push', 'pull', 'clean', 'rebase', 'merge', 'add', 'rm', 'fetch', 'apply', 'config', 'stash', 'tag', 'branch', 'switch', 'restore'];
      assert.ok(run.calls.length >= 2, 'rev-parse then log');
      for (const { args, cwd: callCwd } of run.calls) {
        assert.ok(['log', 'rev-parse'].includes(args[0]), `subcommand ${args[0]} is allowlisted`);
        assert.equal(callCwd, cwd, 'the repo path is the seam cwd, not an argv token');
        for (const token of args) {
          assert.ok(!token.includes(cwd), `argv token ${token} must not contain the repo path`);
          assert.ok(!MUTATING.includes(token), `argv token ${token} must not be a mutating verb`);
        }
      }
      assert.equal(run.calls[0].args[0], 'rev-parse', 'rev-parse runs first (repo probe)');
    });

    it('a hostile cwd that looks like a flag cannot inject anything (it stays the seam cwd)', async () => {
      const cwd = '--upload-pack=touch /tmp/pwned';
      const sessions = [session({ cwd, startedAt: '2026-07-09T10:00:00Z', endedAt: '2026-07-09T11:00:00Z', cost: 1 })];
      const run = spyRun(() => Promise.resolve({ stdout: '', ok: false }));
      // Must not throw; the hostile string is only ever passed as the cwd arg,
      // never spread into argv, so no token in any call equals it as a flag.
      await assert.doesNotReject(() => correlateCommits({ sessions, nowMs: NOW_MS, run }));
      for (const { args, cwd: callCwd } of run.calls) {
        assert.equal(callCwd, cwd, 'hostile string confined to cwd');
        assert.ok(!args.includes(cwd), 'hostile string never appears as an argv token');
      }
    });
  });
  ```

- [ ] **Step 2: Run the test — verify it FAILS.**
  Command: `node --test test/git-value.test.js`
  Expected: `Cannot find module '../lib/git-value.js'` (`ERR_MODULE_NOT_FOUND`) — the module does not exist yet.

- [ ] **Step 3: Implement `lib/git-value.js`.** Complete file:

  ```js
  /**
   * Read-only git ↔ session correlation (Code Insights, Phase 2 — opt-in).
   * Spec: docs/superpowers/specs/2026-07-10-code-insights-design.md
   *
   * Answers "how many commits landed WHILE a Claude Code session was live in
   * this repo, how many lines they added, and what did each cost?" — a
   * CORRELATION, never a per-line "Claude wrote these lines" attribution
   * (spec decision: correlation, not attribution).
   *
   * Purity + I/O seam (house rule): this module performs NO I/O itself. The
   * ONLY side effect — spawning read-only git — is delegated to an INJECTED
   * `run` seam, so unit tests drive it with canned `git log` output and never
   * touch a real repo. The clock is injected via `nowMs` (never Date.now()).
   *
   * SECURITY (first-class — we spawn a subprocess):
   *   - ALLOWLIST: only `log` and `rev-parse` subcommands are ever constructed.
   *     Every args array is validated by assertReadOnlyGitArgs BEFORE it reaches
   *     `run`; a mutating verb (commit/checkout/reset/push/…) can't be built.
   *   - NO PATH IN ARGV: the repo path is passed as the seam's `cwd`, never
   *     interpolated into the argv — a hostile repo path cannot inject a flag.
   *     The only interpolated argv values are ISO timestamps from toISOString().
   *   - NO SHELL (production seam uses execFile — array argv, no shell), so even
   *     a malformed value degrades to a git error, not shell execution.
   *   - PER-REPO ISOLATION: a non-repo / errored / slow cwd degrades to a
   *     graceful skip; the module NEVER throws and one bad repo never sinks the
   *     rest. Each git call is timeout-bounded by the seam.
   */

  import { sumSessionCosts } from './roi-calculator.js';

  /** The ONLY git subcommands this module is ever allowed to construct. */
  export const ALLOWED_GIT_SUBCOMMANDS = Object.freeze(['log', 'rev-parse']);
  const ALLOWED = new Set(ALLOWED_GIT_SUBCOMMANDS);

  // Record/unit separators embedded in the pinned --format so the parser is
  // robust to git's version-dependent blank-line placement around --numstat.
  const RS = '\x1e'; // starts every commit's format line
  const US = '\x1f'; // separates the hash from the author timestamp
  const GIT_LOG_FORMAT = `${RS}%H${US}%at`;

  // Widen the coarse git fetch by a day on each side: --since/--until filter on
  // COMMIT date, but we correlate on AUTHOR date (%at), which can differ. The
  // precise per-commit `inSession` author-time check is the real filter; the
  // margin only prevents author-in-window commits from being clipped by a
  // slightly-outside commit date. It never widens what we COUNT.
  const FETCH_MARGIN_MS = 24 * 60 * 60 * 1000;

  const EMPTY = {
    commits: 0,
    linesCommitted: 0,
    costPerCommit: 0,
    byProject: [],
    commitsWithSession: 0,
  };

  /**
   * Guard: throw unless `args` names an allowlisted, read-only git subcommand.
   * The subcommand is args[0] — this module never passes global options like
   * `-C` on the argv (the repo path is the seam's cwd). Whitelist, not
   * blacklist: anything not explicitly `log`/`rev-parse` is rejected.
   * @param {string[]} args
   */
  export function assertReadOnlyGitArgs(args) {
    if (!Array.isArray(args) || args.length === 0) {
      throw new Error('git-value: refusing to run git with empty args');
    }
    if (!ALLOWED.has(args[0])) {
      throw new Error(
        `git-value: refusing non-allowlisted git subcommand '${String(args[0])}' ` +
          `(allowed: ${ALLOWED_GIT_SUBCOMMANDS.join(', ')})`,
      );
    }
  }

  function revParseArgs() {
    return ['rev-parse', '--is-inside-work-tree'];
  }

  function logArgs(sinceIso, untilIso) {
    return [
      'log',
      '--no-merges',
      '--numstat',
      `--since=${sinceIso}`,
      `--until=${untilIso}`,
      `--format=${GIT_LOG_FORMAT}`,
    ];
  }

  /**
   * Call the injected seam behind the allowlist guard. NEVER throws — a seam
   * rejection or a thrown guard both degrade to {stdout:'', ok:false}.
   */
  async function safeRun(run, args, cwd) {
    try {
      assertReadOnlyGitArgs(args);
      const res = await run(args, cwd);
      if (!res || typeof res !== 'object') return { stdout: '', ok: false };
      return {
        stdout: typeof res.stdout === 'string' ? res.stdout : '',
        ok: res.ok === true,
      };
    } catch {
      return { stdout: '', ok: false };
    }
  }

  function parseMs(value) {
    if (typeof value !== 'string' || value === '') return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  /**
   * Parse `git log --numstat --format=<RS>%H<US>%at` output. Robust to blank
   * lines: split on RS; each chunk is one commit (header line + numstat rows).
   * Binary files render '-' in numstat and contribute 0 lines.
   * @param {string} stdout
   * @returns {Array<{hash: string, atMs: number, added: number}>}
   */
  function parseGitLog(stdout) {
    const commits = [];
    for (const chunk of String(stdout).split(RS)) {
      if (chunk.trim() === '') continue;
      const lines = chunk.split('\n');
      const [hash, atStr] = lines[0].split(US);
      const at = Number(atStr);
      if (!hash || !Number.isFinite(at)) continue;
      let added = 0;
      for (let i = 1; i < lines.length; i++) {
        const m = lines[i].match(/^(\d+|-)\t(\d+|-)\t/);
        if (!m) continue;
        if (m[1] !== '-') added += Number(m[1]);
      }
      commits.push({ hash, atMs: at * 1000, added });
    }
    return commits;
  }

  /**
   * Correlate git commits with Claude Code sessions per repo. See module
   * docstring + the plan's pinned semantic decisions.
   *
   * @param {object} args
   * @param {Array<{cwd?: string, project?: string, startedAt?: string, endedAt?: string, cost?: number}>} args.sessions
   * @param {number} args.nowMs injected clock — upper-bounds every window/until.
   * @param {(a: string[], cwd: string) => Promise<{stdout: string, ok: boolean}>} args.run
   * @returns {Promise<{commits: number, linesCommitted: number, costPerCommit: number,
   *   byProject: Array<{project: string, commits: number, linesCommitted: number}>,
   *   commitsWithSession: number}>}
   */
  export async function correlateCommits({ sessions, nowMs, run } = {}) {
    if (typeof run !== 'function' || !Array.isArray(sessions) || sessions.length === 0) {
      return { ...EMPTY, byProject: [] };
    }
    const now = Number.isFinite(nowMs) ? nowMs : null;

    // Group by the REAL repo path (session.cwd — the git target), NOT
    // session.project (a basename via resolveProjectName). Carry the friendly
    // project name for display. Clamp future ends to `now`.
    const byCwd = new Map();
    for (const s of sessions) {
      const cwd = typeof s?.cwd === 'string' && s.cwd !== '' ? s.cwd : null;
      if (!cwd) continue;
      const startMs = parseMs(s.startedAt);
      let endMs = parseMs(s.endedAt);
      if (startMs == null || endMs == null) continue;
      if (now != null && endMs > now) endMs = now;
      if (endMs < startMs) continue;
      const g = byCwd.get(cwd) ?? { cwd, project: s.project ?? cwd, windows: [] };
      g.windows.push([startMs, endMs]);
      byCwd.set(cwd, g);
    }

    const byProject = [];
    let totalCommits = 0;
    let totalLines = 0;

    for (const g of byCwd.values()) {
      let projectCommits = 0;
      let projectLines = 0;
      try {
        const probe = await safeRun(run, revParseArgs(), g.cwd);
        if (!probe.ok || probe.stdout.trim() !== 'true') continue;

        const sinceMs = Math.min(...g.windows.map((w) => w[0]));
        const untilMs = Math.max(...g.windows.map((w) => w[1]));
        if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) continue;
        const untilCapMs = now != null ? Math.min(untilMs + FETCH_MARGIN_MS, now) : untilMs + FETCH_MARGIN_MS;
        const sinceIso = new Date(sinceMs - FETCH_MARGIN_MS).toISOString();
        const untilIso = new Date(Math.max(untilCapMs, sinceMs)).toISOString();

        const res = await safeRun(run, logArgs(sinceIso, untilIso), g.cwd);
        if (!res.ok) continue;

        for (const commit of parseGitLog(res.stdout)) {
          const inSession = g.windows.some(([a, b]) => commit.atMs >= a && commit.atMs <= b);
          if (!inSession) continue;
          projectCommits += 1;
          projectLines += commit.added;
        }
      } catch {
        continue; // per-repo isolation — one bad repo never throws out of the loop
      }
      if (projectCommits > 0 || projectLines > 0) {
        byProject.push({ project: g.project, commits: projectCommits, linesCommitted: projectLines });
      }
      totalCommits += projectCommits;
      totalLines += projectLines;
    }

    byProject.sort((a, b) => b.commits - a.commits || b.linesCommitted - a.linesCommitted);

    const totalCost = sumSessionCosts(sessions);
    const costPerCommit = totalCommits === 0 ? 0 : totalCost / totalCommits;

    return {
      commits: totalCommits,
      linesCommitted: totalLines,
      costPerCommit,
      byProject,
      commitsWithSession: totalCommits, // === commits by construction (pinned decision #1)
    };
  }
  ```

- [ ] **Step 4: Run the test — verify it PASSES.**
  Command: `node --test test/git-value.test.js`
  Expected: all tests pass (`# fail 0`).

- [ ] **Step 5: Add AGENTS.md landmine #45 (the read-only-git allowlist is a stable codebase rule).** Append after landmine #44:

  ```md
  ### 45. `lib/git-value.js` spawns git — READ-ONLY allowlist + the repo path NEVER on the argv

  Phase 2's git correlation is the only place Clauge spawns git. It is opt-in
  (`gitValueEnabled`, default false) and must stay strictly read-only. Two rules
  are load-bearing and enforced by `test/git-value.test.js`:
  (1) **Subcommand allowlist** — `correlateCommits` may construct ONLY `log` and
  `rev-parse` argv (`ALLOWED_GIT_SUBCOMMANDS`); every args array is validated by
  `assertReadOnlyGitArgs` before it reaches the injected `run` seam, so a
  mutating verb (commit/checkout/reset/push/…) can never be built. (2) **No path
  in argv** — the repo path is the seam's `cwd` argument, never a git argv token
  (no `-C <path>`), so a hostile repo path cannot inject a flag; the production
  seam uses `execFile` (array argv, NO shell). A non-repo / errored / slow cwd
  degrades to a graceful skip (never throws; one bad repo never sinks the rest),
  bounded by a timeout in the seam. When you touch git-value: keep the spawn
  behind the injected `run` seam (lib/ stays pure + testable with canned output),
  keep the allowlist a whitelist, and never move the cwd onto the argv.
  ```

- [ ] **Step 6: Full gate + commit.**
  Run the FULL gate: `npm run check` (expected green). Then:
  ```bash
  git add lib/git-value.js test/git-value.test.js AGENTS.md
  git commit -m "feat(git-value): pure read-only git↔session correlation engine

  correlateCommits({sessions, nowMs, run}) correlates commits to Claude Code
  sessions per repo via an INJECTED read-only git seam (log/rev-parse only,
  allowlisted; repo path stays the seam cwd, never an argv token). Graceful
  per-repo skip on non-repo/error; no I/O in lib/, clock injected. AGENTS #45."
  ```

---

## PR 2 — `feat/git-value-wiring` (Tasks 2–4, after PR 1 merges)

> **Preconditions (on `main`):** `lib/git-value.js` exports `correlateCommits`. Config flag + routes + snapshot key. NO new dependency. NO new served frontend asset (so `test:sea` stays dorment — landmine #39). House rules as in PR 1.

### Task 2: `lib/config-store.js` — `gitValueEnabled` flag (read-merge-write, default FALSE)

**Why:** Opt-in. Mirrors the alerts pref pattern (read-merge-write so unrelated keys survive), but the default is **false** (alerts default true). Stored as a flat top-level boolean `gitValueEnabled` in `~/.clauge/config.json`, alongside `subscriptionCost` + `alerts`.

**Files**
- Modify: `/Users/adnanrashid/Projects/clauge/lib/config-store.js` — add `DEFAULT_GIT_VALUE_ENABLED` const + two methods.
- Test: `/Users/adnanrashid/Projects/clauge/test/config-store.test.js` — append a describe block (helpers `makeStore`/`writeConfig` already exist at the top of the file).

**Steps**

- [ ] **Step 1: Write failing tests.** Append after the last describe block in `test/config-store.test.js`:

  ```js
  // ── gitValueEnabled (Code Insights Phase 2 — opt-in, default FALSE) ──
  // Flat top-level boolean in the SAME ~/.clauge/config.json (read-merge-write),
  // so it must coexist with subscriptionCost and the alerts block.
  describe('gitValueEnabled — default false + read-merge-write coexistence', () => {
    it('defaults to false when no file exists', async () => {
      assert.equal(await makeStore({}).effectiveGitValueEnabled(), false);
    });

    it('defaults to false when the key is absent', async () => {
      await writeConfig(JSON.stringify({ v: 1, subscriptionCost: 200 }));
      assert.equal(await makeStore({}).effectiveGitValueEnabled(), false);
    });

    it('coerces a non-boolean value to false', async () => {
      await writeConfig(JSON.stringify({ v: 1, gitValueEnabled: 'yes' }));
      assert.equal(await makeStore({}).effectiveGitValueEnabled(), false);
    });

    it('reads a real true', async () => {
      await writeConfig(JSON.stringify({ v: 1, gitValueEnabled: true }));
      assert.equal(await makeStore({}).effectiveGitValueEnabled(), true);
    });

    it('setGitValueEnabled persists and a fresh instance rereads it', async () => {
      const eff = await makeStore({}).setGitValueEnabled(true);
      assert.deepEqual(eff, { enabled: true });
      assert.equal(await makeStore({}).effectiveGitValueEnabled(), true);
    });

    it('setGitValueEnabled preserves subscriptionCost and the alerts block', async () => {
      await writeConfig(
        JSON.stringify({
          v: 1,
          subscriptionCost: 150,
          alerts: { enabled: false, types: { approaching: false, willHit: true, limitReached: true } },
        }),
      );
      await makeStore({}).setGitValueEnabled(true);
      const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
      assert.equal(onDisk.subscriptionCost, 150, 'cost preserved');
      assert.equal(onDisk.gitValueEnabled, true, 'flag written');
      assert.deepEqual(onDisk.alerts.types, { approaching: false, willHit: true, limitReached: true }, 'alerts untouched');
    });

    it('setSubscriptionCost preserves an existing gitValueEnabled', async () => {
      await writeConfig(JSON.stringify({ v: 1, gitValueEnabled: true }));
      await makeStore({}).setSubscriptionCost(120);
      const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
      assert.equal(onDisk.subscriptionCost, 120);
      assert.equal(onDisk.gitValueEnabled, true, 'flag survives a cost write');
    });

    it('rejects a non-boolean argument', async () => {
      await assert.rejects(() => makeStore({}).setGitValueEnabled('on'), /boolean/);
    });

    it('leaves no .tmp file behind (atomic tmp + rename)', async () => {
      await makeStore({}).setGitValueEnabled(true);
      const entries = await readdir(dir);
      assert.deepEqual(entries, ['config.json']);
    });
  });
  ```

- [ ] **Step 2: Run and confirm FAIL.** `node --test test/config-store.test.js` → the new block fails (`effectiveGitValueEnabled is not a function`). Pre-existing blocks stay green.

- [ ] **Step 3: Add the default const.** In `lib/config-store.js`, after `const DEFAULT_SUBSCRIPTION_COST = 200;` (line 27) add:

  ```js
  // Code Insights Phase 2: read-only git correlation is OPT-IN. Default false
  // (unlike alerts, which default true) — no git ever runs until the user flips
  // this in Settings / the Value panel.
  const DEFAULT_GIT_VALUE_ENABLED = false;
  ```

- [ ] **Step 4: Add the two methods.** Insert inside `class ConfigStore`, immediately after `setAlertPrefs` (before the closing `}` of the class, ~line 207):

  ```js
    /**
     * Whether the opt-in read-only git correlation is enabled. Flat top-level
     * boolean in config.json; a missing/corrupt file or non-boolean value ->
     * false (opt-in, so absence means OFF).
     * @returns {Promise<boolean>}
     */
    async effectiveGitValueEnabled() {
      const all = await this.readAll();
      return typeof all.gitValueEnabled === 'boolean'
        ? all.gitValueEnabled
        : DEFAULT_GIT_VALUE_ENABLED;
    }

    /**
     * Flip the git-value opt-in via read-merge-write (preserves subscriptionCost
     * + the alerts block). Validates a real boolean (throws otherwise — a bad
     * write must not silently no-op). Returns the persisted state.
     * @param {boolean} enabled
     * @returns {Promise<{enabled: boolean}>}
     */
    async setGitValueEnabled(enabled) {
      if (typeof enabled !== 'boolean') {
        throw new Error(`gitValueEnabled must be a boolean, got: ${String(enabled)}`);
      }
      const all = await this.readAll();
      await this.writeAll({ ...all, gitValueEnabled: enabled });
      return { enabled };
    }
  ```

- [ ] **Step 5: Run and confirm PASS.** `node --test test/config-store.test.js` → all green. Commit at the end of PR 2 (or per-task, matching house style — this plan commits per task for a clean history).

  ```bash
  git add lib/config-store.js test/config-store.test.js
  git commit -m "feat(config-store): gitValueEnabled opt-in flag (default false, read-merge-write)"
  ```

### Task 3: `server.js` — `GET /api/git-value`, `POST /api/config/git-value`, config report, default git seam

**Why:** The dashboard reads `GET /api/git-value` (cross-origin loopback → must be in `READ_ONLY_API_PATHS`); the toggle POSTs `/api/config/git-value` (same-origin, mirrors `POST /api/config/alerts`); `GET /api/config` reports the flag so the toggle can paint its initial state. The production git seam (`execFile`, timeout-bounded, never rejects) lives here — the I/O boundary — keeping `lib/git-value.js` pure.

**Files**
- Modify: `/Users/adnanrashid/Projects/clauge/server.js`
- Test: `/Users/adnanrashid/Projects/clauge/test/server-additions.test.js` — append a describe block (reuse the file's existing `startServer` + `CLAUGE_HOME` sandbox helpers; confirm their names before writing — the alerts suites established them).

**Steps**

- [ ] **Step 1: Write the failing server tests.** Append to `test/server-additions.test.js`. With a `CLAUGE_HOME` + `HOME` sandbox there are no sessions and no repos, so an enabled `GET /api/git-value` returns all-zeros — **no git is spawned** (empty sessions short-circuit `correlateCommits`), which keeps the suite hermetic and fast.

  ```js
  // Code Insights Phase 2: GET /api/git-value (opt-in gate) + POST
  // /api/config/git-value + GET /api/config reflection. Sandbox ~/.clauge AND
  // ~/.claude via CLAUGE_HOME + HOME so there are no sessions/repos — an enabled
  // git-value call short-circuits to all-zeros (no git spawned). Uses the
  // existing startServer helper in this file.
  describe('git-value (opt-in) — /api/git-value + /api/config/git-value', () => {
    let server, home;
    const PORT = '3560';
    const BASE = `http://127.0.0.1:${PORT}`;

    before(async () => {
      home = await mkdtemp(`${tmpdir()}/clauge-git-value-`);
      server = await startServer({ PORT, CLAUGE_HOME: home, HOME: home });
    });

    after(async () => {
      if (server && !server.killed) {
        server.kill('SIGTERM');
        await new Promise((r) => server.once('exit', r));
      }
      await rm(home, { recursive: true, force: true });
    });

    it('GET /api/config reports gitValueEnabled:false by default', async () => {
      const cfg = await (await fetch(`${BASE}/api/config`)).json();
      assert.equal(cfg.gitValueEnabled, false);
    });

    it('GET /api/git-value returns {enabled:false} while off (no git runs)', async () => {
      const body = await (await fetch(`${BASE}/api/git-value?period=30d`)).json();
      assert.deepEqual(body, { enabled: false });
    });

    it('POST /api/config/git-value flips the flag and returns {enabled}', async () => {
      const res = await fetch(`${BASE}/api/config/git-value`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { enabled: true });

      const cfg = await (await fetch(`${BASE}/api/config`)).json();
      assert.equal(cfg.gitValueEnabled, true, 'GET /api/config reflects the persisted flip');
    });

    it('GET /api/git-value returns the enabled shape once on (all-zero in a sandbox)', async () => {
      const body = await (await fetch(`${BASE}/api/git-value?period=30d`)).json();
      assert.deepEqual(Object.keys(body).sort(), ['byProject', 'commits', 'costPerCommit', 'enabled', 'linesCommitted']);
      assert.equal(body.enabled, true);
      assert.equal(body.commits, 0);
      assert.equal(body.linesCommitted, 0);
      assert.equal(body.costPerCommit, 0);
      assert.deepEqual(body.byProject, []);
    });

    it('rejects a non-boolean enabled with 400', async () => {
      const res = await fetch(`${BASE}/api/config/git-value`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: 'on' }),
      });
      assert.equal(res.status, 400);
    });

    it('rejects non-JSON with 400', async () => {
      const res = await fetch(`${BASE}/api/config/git-value`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      assert.equal(res.status, 400);
    });

    it('rejects an invalid period with 400', async () => {
      const res = await fetch(`${BASE}/api/git-value?period=nonsense`);
      assert.equal(res.status, 400);
    });
  });
  ```

  > NOTE: the invalid-period test only passes AFTER the flag is on (an OFF flag returns `{enabled:false}` before period parsing). This block runs sequentially and the POST test flips the flag ON first, so by the invalid-period case the flag is on — the handler must validate the flag first, then the period. Order the handler exactly that way (Step 4).

- [ ] **Step 2: Run and confirm FAIL.** `node --test test/server-additions.test.js` → the new block fails (`gitValueEnabled` undefined on `/api/config`; `/api/git-value` and `/api/config/git-value` 404).

- [ ] **Step 3: Imports + default git seam.** In `server.js`:

  Add the module import beside `buildProjection`/`evaluate` (after line 44):
  ```js
  import { correlateCommits } from './lib/git-value.js';
  ```
  Add `execFile` to the node imports near the top (after `import { readFileSync } from 'node:fs';`, line 15):
  ```js
  import { execFile } from 'node:child_process';
  ```
  Add the production seam near the other top-level consts (e.g. after `PRUNE_INTERVAL_MS`, line 113). It NEVER rejects (a git error / missing binary / timeout → `{ok:false}`), is timeout-bounded, and passes the repo path ONLY as `cwd` (never argv — landmine #45):
  ```js
  // Production git seam for lib/git-value.js (Code Insights Phase 2). READ-ONLY
  // by construction: git-value only ever hands us `log`/`rev-parse` argv (guarded
  // there). execFile => array argv, NO shell, so a weird path can't inject. The
  // repo path is the `cwd` option, never an argv token. Bounded by GIT_TIMEOUT_MS;
  // any error (non-zero exit, ENOENT git-not-installed, timeout) resolves ok:false
  // so one slow/broken repo degrades to a skip and never hangs or fails the route.
  const GIT_TIMEOUT_MS = 5000;
  const GIT_MAX_BUFFER = 8 * 1024 * 1024;
  function gitRun(args, cwd) {
    return new Promise((resolve) => {
      execFile(
        'git',
        args,
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
        (err, stdout) => resolve(err ? { stdout: '', ok: false } : { stdout: stdout ?? '', ok: true }),
      );
    });
  }
  ```

- [ ] **Step 4: Add `/api/git-value` to the read-only CORS allowlist.** In the `READ_ONLY_API_PATHS` array (ends `'/api/projection',` at line 205), add:
  ```js
    '/api/projection',
    '/api/git-value',
  ```
  (The dashboard webview reads `/api/git-value` cross-origin from loopback — it MUST be in the allowlist, unlike the loopback-only `/api/alerts/pending`.)

- [ ] **Step 5: Extend `GET /api/config` to report the flag.** In the `GET /api/config` handler (lines 674–683), add `gitValueEnabled`:
  ```js
  app.get('/api/config', async (c) => {
    const providers = await listProviders();
    return c.json({
      claudeDir: CLAUDE_DIR,
      subscriptionCost: await configStore.effectiveSubscriptionCost(),
      alerts: await configStore.effectiveAlertPrefs(),
      gitValueEnabled: await configStore.effectiveGitValueEnabled(),
      pricing: { source: priceTable.source, fetchedAt: priceTable.fetchedAt },
      providers,
    });
  });
  ```

- [ ] **Step 6: Add the two new routes.** Insert immediately after the `POST /api/config/alerts` handler (after line 756):
  ```js
  // Code Insights Phase 2 (opt-in read-only git correlation). Gate on the flag
  // FIRST — an OFF flag returns {enabled:false} and NO git runs. Then validate
  // the period, filter sessions, and hand them to the pure correlateCommits with
  // the production gitRun seam. The webview reads this cross-origin (loopback) —
  // it is in READ_ONLY_API_PATHS. Correlation, not attribution (see UI copy).
  app.get('/api/git-value', async (c) => {
    if (!(await configStore.effectiveGitValueEnabled())) {
      return c.json({ enabled: false });
    }
    const filtered = await loadFiltered(c);
    if (filtered.error) return c.json(filtered, 400);
    const { commits, linesCommitted, costPerCommit, byProject } = await correlateCommits({
      sessions: filtered.sessions,
      nowMs: Date.now(),
      run: gitRun,
    });
    return c.json({ enabled: true, commits, linesCommitted, costPerCommit, byProject });
  });

  // Flip the git-value opt-in. Same-origin dashboard POST (no CORS middleware —
  // the '/api/config' entry in READ_ONLY_API_PATHS does not match this subpath).
  // Body: { enabled: boolean }. 400 on non-JSON / non-boolean. Mirrors
  // POST /api/config/subscription-cost + /api/config/alerts.
  app.post('/api/config/git-value', async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    if (!body || typeof body.enabled !== 'boolean') {
      return c.json({ error: 'expected body: { enabled: boolean }' }, 400);
    }
    const result = await configStore.setGitValueEnabled(body.enabled);
    return c.json(result);
  });
  ```

- [ ] **Step 7: Run and confirm PASS.** `node --test test/server-additions.test.js` → all green (incl. the new block). Then `node --test test/server-projection.test.js` and any CORS validator to confirm no regression: `npm run check:validators`.

- [ ] **Step 8: Commit.**
  ```bash
  git add server.js test/server-additions.test.js
  git commit -m "feat(git-value): /api/git-value + /api/config/git-value + gitRun seam

  GET /api/git-value gates on gitValueEnabled (off -> {enabled:false}, no git),
  then correlates period-filtered sessions via the production execFile seam
  (read-only, timeout-bounded, path never on argv). POST /api/config/git-value
  flips the flag (mirrors /api/config/alerts). GET /api/config reports it.
  /api/git-value added to READ_ONLY_API_PATHS (webview reads it cross-origin)."
  ```

### Task 4: `lib/snapshot.js` — optional `gitValue` key (only when enabled), schemaVersion STAYS 1

**Why:** Phase 4 (iOS) will surface git value; the Mac publishes it now as an **additive optional** top-level key. Present only when enabled; the object carries only numbers/array (no bare-null typed slots — review #26). `SNAPSHOT_SCHEMA_VERSION` stays 1 (landmine #37/#42). Computed in the `/api/snapshot` HANDLER (the I/O boundary) with the `gitRun` seam and passed VERBATIM into `buildSnapshot` (which stays pure), the same way `weekOverWeek`/`roiPace` are threaded.

**Files**
- Modify: `/Users/adnanrashid/Projects/clauge/lib/snapshot.js` — new param `gitValue = null`; attach only when non-null.
- Modify: `/Users/adnanrashid/Projects/clauge/server.js` — `/api/snapshot` handler computes `gitValue` when enabled and threads it.
- Test: `/Users/adnanrashid/Projects/clauge/test/snapshot.test.js` — append a describe block.

**Steps**

- [ ] **Step 1: Write failing snapshot tests.** Append to `test/snapshot.test.js` (the `build(...)` helper + `makeSession` already exist near the top):

  ```js
  describe('buildSnapshot — optional gitValue key (Code Insights Phase 2)', () => {
    it('omits gitValue entirely when the param is null (default / disabled)', async () => {
      const snap = await build([makeSession()]);
      assert.equal('gitValue' in snap, false, 'no gitValue key when disabled');
      assert.equal(snap.schemaVersion, 1, 'schemaVersion stays 1');
    });

    it('attaches gitValue verbatim when provided, schemaVersion still 1, no null slots', async () => {
      const gitValue = {
        commits: 3,
        linesCommitted: 42,
        costPerCommit: 1.5,
        byProject: [{ project: 'clauge', commits: 3, linesCommitted: 42 }],
      };
      const snap = await build([makeSession()], null, { gitValue });
      assert.equal(snap.schemaVersion, 1);
      assert.deepEqual(snap.gitValue, gitValue, 'passed through verbatim');
      // No bare-null typed slots (review #26): every numeric field is a number.
      for (const k of ['commits', 'linesCommitted', 'costPerCommit']) {
        assert.equal(typeof snap.gitValue[k], 'number');
      }
      assert.ok(Array.isArray(snap.gitValue.byProject));
    });

    it('attaches an all-zero gitValue (enabled but no commits) — still a number, never null', async () => {
      const gitValue = { commits: 0, linesCommitted: 0, costPerCommit: 0, byProject: [] };
      const snap = await build([makeSession()], null, { gitValue });
      assert.deepEqual(snap.gitValue, gitValue);
      assert.equal(snap.gitValue.costPerCommit, 0, '0-guard, not null');
    });
  });
  ```

- [ ] **Step 2: Run and confirm FAIL.** `node --test test/snapshot.test.js` → the two "attaches" cases fail (`snap.gitValue` is `undefined`).

- [ ] **Step 3: Add the `gitValue` param to `buildSnapshot`.** In `lib/snapshot.js`, extend the destructured params (after `roiPace = null,`, line 285):
  ```js
    roiPace = null,
    gitValue = null,
  ```
  Extend the JSDoc `@param` block (after the `roiPace` param doc, ~line 274):
  ```js
   * @param {{commits: number, linesCommitted: number, costPerCommit: number,
   *   byProject: Array<{project, commits, linesCommitted}>} | null} [args.gitValue=null]
   *   Code Insights Phase 2 read-only git correlation, computed by the handler
   *   via correlateCommits with the production git seam and passed VERBATIM (never
   *   recomputed here — snapshot.js stays pure). Present as an OPTIONAL top-level
   *   key ONLY when non-null (enabled); schemaVersion STAYS 1 (landmine #37).
  ```
  In the returned object, add the optional key at the end (after `forecast: { weekOverWeek, roiPace },`, line 318):
  ```js
      forecast: { weekOverWeek, roiPace },
      // Code Insights Phase 2 (optional, schemaVersion stays 1): read-only git
      // correlation, present ONLY when enabled. Numbers/array only — never a
      // bare-null typed slot (review #26). Old iOS ignores this unknown key.
      ...(gitValue ? { gitValue } : {}),
  ```

- [ ] **Step 4: Thread `gitValue` through the `/api/snapshot` handler.** In `server.js`, replace the `/api/snapshot` handler body (lines 653–672) so it computes `gitValue` when enabled and passes it to `buildSnapshot`. The git correlation uses the SAME 30-day window `buildSnapshot` uses for its headline breakdowns (`DEFAULT_PERIOD`), on the SAME `nowMs`:
  ```js
  app.get('/api/snapshot', async (c) => {
    const tz = c.req.query('tz') ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    const nowMs = Date.now();
    const { projection, history } = await buildLiveProjection(nowMs);
    // Code Insights Phase 2: publish read-only git value ONLY when opted in.
    // Computed HERE (I/O boundary) with the production git seam over the same
    // 30d window the snapshot headlines use; passed VERBATIM to buildSnapshot.
    let gitValue = null;
    if (await configStore.effectiveGitValueEnabled()) {
      const allForGit = await store.loadAllSummaries();
      const gitSessions = filterSessions(allForGit, { period: '30d', project: '', now: new Date(nowMs) });
      gitValue = await correlateCommits({ sessions: gitSessions, nowMs, run: gitRun });
    }
    const snapshot = await buildSnapshot({
      store,
      usageStore,
      subscriptionCost: await configStore.effectiveSubscriptionCost(),
      tz,
      now: new Date(nowMs),
      history,
      weekOverWeek: projection.windows?.sevenDay?.weekOverWeek ?? null,
      roiPace: projection.roiPace ?? null,
      gitValue,
    });
    return c.json(snapshot);
  });
  ```
  > NOTE: `correlateCommits` returns `commitsWithSession` too; `buildSnapshot` attaches the object verbatim, so the snapshot's `gitValue` carries that alias as well. That is harmless (additive) and matches the module contract. If a byte-tight snapshot budget later matters, strip it in the handler to `{ commits, linesCommitted, costPerCommit, byProject }` before passing — but do NOT introduce nulls.

- [ ] **Step 5: Run and confirm PASS.** `node --test test/snapshot.test.js` and `node --test test/server-snapshot-forecast.test.js` (confirm the `/api/snapshot` wiring change didn't disturb the forecast threading). Then the full JS suite: `npm test`.

- [ ] **Step 6: Commit.**
  ```bash
  git add lib/snapshot.js server.js test/snapshot.test.js
  git commit -m "feat(git-value): publish optional gitValue snapshot key when enabled

  buildSnapshot attaches gitValue VERBATIM as an additive optional top-level key
  (present only when enabled; numbers/array only, no bare-null slots). Handler
  computes it via correlateCommits + the git seam over the 30d window on one
  nowMs. schemaVersion STAYS 1 (landmine #37) — old iOS ignores the new key."
  ```

---

## PR 3 — `feat/git-value-dashboard` (Tasks 5–6, after PR 2 merges)

> Dashboard Value panel under the existing Code Insights area. NO new served JS file (the pure helper rides in the already-served `public/swr.js`), so landmine #39's dual-SEA-manifest rule stays dormant. Surgical value updates on auto-refresh (landmine #22 — no `innerHTML=` on animated regions; write `textContent` on leaf nodes). Copy makes the read-only correlation (NOT per-line attribution) explicit.

### Task 5: `public/swr.js` — pure `gitValueView` mapping + vm tests

**Files**
- Modify: `/Users/adnanrashid/Projects/clauge/public/swr.js` — add `gitValueView`, export it on `window.ClaugeDashSwr`.
- Test: `/Users/adnanrashid/Projects/clauge/test/dashboard-swr.test.js` — pull the new helper from the destructure + append a describe block.

**Steps**

- [ ] **Step 1: Write failing tests.** In `test/dashboard-swr.test.js`, extend the destructure (line 25):
  ```js
  const { syncMeta, shouldSkipTick, alertPrefsView, gitValueView } = loadDashSwr();
  ```
  Append a describe block after the existing ones:
  ```js
  describe('gitValueView — /api/git-value payload -> Value panel view model', () => {
    it('disabled payload -> enabled:false, hasData:false', () => {
      assert.deepEqual(gitValueView({ enabled: false }), {
        enabled: false,
        hasData: false,
        commits: 0,
        linesCommitted: 0,
        costPerCommit: 0,
        byProject: [],
      });
    });

    it('enabled but zero commits -> hasData:false (coached empty state)', () => {
      const v = gitValueView({ enabled: true, commits: 0, linesCommitted: 0, costPerCommit: 0, byProject: [] });
      assert.equal(v.enabled, true);
      assert.equal(v.hasData, false);
    });

    it('enabled with commits -> hasData:true and numbers pass through', () => {
      const v = gitValueView({
        enabled: true,
        commits: 3,
        linesCommitted: 42,
        costPerCommit: 1.5,
        byProject: [{ project: 'clauge', commits: 3, linesCommitted: 42 }],
      });
      assert.deepEqual(v, {
        enabled: true,
        hasData: true,
        commits: 3,
        linesCommitted: 42,
        costPerCommit: 1.5,
        byProject: [{ project: 'clauge', commits: 3, linesCommitted: 42 }],
      });
    });

    it('garbage / null payload -> safe disabled defaults (never throws)', () => {
      for (const bad of [null, undefined, 42, 'x', {}]) {
        const v = gitValueView(bad);
        assert.equal(v.enabled, false);
        assert.equal(v.hasData, false);
        assert.deepEqual(v.byProject, []);
      }
    });

    it('coerces non-finite numeric fields to 0', () => {
      const v = gitValueView({ enabled: true, commits: 'x', linesCommitted: null, costPerCommit: undefined, byProject: 'nope' });
      assert.equal(v.commits, 0);
      assert.equal(v.linesCommitted, 0);
      assert.equal(v.costPerCommit, 0);
      assert.deepEqual(v.byProject, []);
    });
  });
  ```

- [ ] **Step 2: Run and confirm FAIL.** `node --test test/dashboard-swr.test.js` → `gitValueView is not a function`.

- [ ] **Step 3: Add the helper.** In `public/swr.js`, add `gitValueView` after `alertPrefsView` (before the `if (typeof window …)` block, line 108):
  ```js
    // ── Git Value display mapping (Code Insights Phase 2) ───────────────────
    // Pure: the /api/git-value payload → the Value panel view model. `hasData`
    // is true ONLY when enabled AND at least one commit correlated — the panel
    // shows a coached opt-in/empty state otherwise (no scary zeroes). All
    // numeric fields are coerced to finite numbers; byProject defaults to [].
    function gitValueView(payload) {
      const p = payload && typeof payload === 'object' ? payload : {};
      const num = (v) => (Number.isFinite(v) ? v : 0);
      const enabled = p.enabled === true;
      const commits = num(p.commits);
      return {
        enabled,
        hasData: enabled && commits > 0,
        commits,
        linesCommitted: num(p.linesCommitted),
        costPerCommit: num(p.costPerCommit),
        byProject: Array.isArray(p.byProject) ? p.byProject : [],
      };
    }
  ```
  Extend the export (line 110):
  ```js
      window.ClaugeDashSwr = { syncMeta, shouldSkipTick, projectionLine, wowLine, paceLine, alertPrefsView, gitValueView };
  ```

- [ ] **Step 4: Run and confirm PASS + commit.** `node --test test/dashboard-swr.test.js` → green.
  ```bash
  git add public/swr.js test/dashboard-swr.test.js
  git commit -m "feat(git-value): pure gitValueView mapping for the dashboard Value panel"
  ```

### Task 6: Dashboard Value panel — `index.html` + `styles.css` + `app.js`

**Why:** Surface commits-during-sessions / lines committed / cost-per-commit under Code Insights, with a clear opt-in toggle and copy stating it is **read-only git correlation, not per-line attribution**. Disabled → a coached opt-in state; enabled-but-no-data → a coached empty state; enabled-with-data → the metrics. This is webview wiring on already-served `public/*` files — NO new served asset (landmine #39 dormant). Value updates are surgical (`textContent` on leaf spans — landmine #22).

**Files**
- Modify: `/Users/adnanrashid/Projects/clauge/public/index.html` — add the Value panel inside the Code Insights area Phase 1 created. **First confirm the container id** (`grep -n "code-insights\|Code Insights" public/index.html`) and place the panel inside it; if Phase 1's container differs, adjust the anchor but keep the panel's own ids below.
- Modify: `/Users/adnanrashid/Projects/clauge/public/styles.css` — panel + coached-state styles.
- Modify: `/Users/adnanrashid/Projects/clauge/public/app.js` — `renderGitValue()`, `initGitValueControls()`, and a best-effort `/api/git-value` fetch in `refreshAll()`.

**Pinned element ids (app.js + any future test rely on these):** panel root `#git-value-panel` (with `data-state="disabled|empty|ready"`); toggle `#git-value-enabled`; status `#git-value-status`; value slots `#git-value-commits`, `#git-value-lines`, `#git-value-cost`; per-project list `#git-value-projects`.

**Steps**

- [ ] **Step 1: Add the panel markup** inside the Code Insights container (Phase 1). Markup:
  ```html
  <section class="card git-value-panel" id="git-value-panel" data-state="disabled" aria-labelledby="git-value-title">
    <div class="git-value-head">
      <div>
        <h3 id="git-value-title">Value from commits</h3>
        <p class="git-value-sub">Correlates commits made <em>while a Claude Code session was live</em> in each repo — read-only. It never reads which lines are whose; this is correlation, not per-line attribution. Clauge never writes to git.</p>
      </div>
      <label class="toggle-wrap" title="Enable read-only git correlation">
        <input type="checkbox" id="git-value-enabled">
        <span class="toggle-slider"></span>
      </label>
    </div>
    <div class="git-value-status mono" id="git-value-status"></div>

    <!-- disabled: coached opt-in -->
    <p class="git-value-coach git-value-when-disabled">Turn this on to see commits-during-sessions, lines committed, and cost per commit. Clauge runs <code>git log</code> locally, read-only — nothing leaves your machine and nothing in git is modified.</p>

    <!-- empty: enabled but no correlated commits yet -->
    <p class="git-value-coach git-value-when-empty">No commits landed during a Claude Code session in this window yet. Commit while you work and they'll show here.</p>

    <!-- ready: the metrics -->
    <div class="git-value-metrics git-value-when-ready">
      <div class="git-value-metric">
        <div class="git-value-num" id="git-value-commits">0</div>
        <div class="git-value-label">commits during sessions</div>
      </div>
      <div class="git-value-metric">
        <div class="git-value-num" id="git-value-lines">0</div>
        <div class="git-value-label">lines committed</div>
      </div>
      <div class="git-value-metric">
        <div class="git-value-num" id="git-value-cost">$0.00</div>
        <div class="git-value-label">cost per commit</div>
      </div>
      <ul class="git-value-projects" id="git-value-projects"></ul>
    </div>
  </section>
  ```

- [ ] **Step 2: Add styles** to `public/styles.css` (match the existing card/token vocabulary — reuse `--*` custom properties already defined in the file; the three coached-state blocks are shown/hidden by `data-state` on the root):
  ```css
  .git-value-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .git-value-sub { font-size: 12px; color: var(--muted); margin-top: 4px; max-width: 52ch; }
  .git-value-status { min-height: 14px; font-size: 11px; color: var(--muted); margin-top: 6px; }
  .git-value-coach { font-size: 12px; color: var(--muted); margin-top: 10px; max-width: 56ch; }
  .git-value-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 12px; }
  .git-value-num { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; }
  .git-value-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .git-value-projects { grid-column: 1 / -1; list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .git-value-projects li { display: flex; justify-content: space-between; font-size: 12px; color: var(--text); }
  .git-value-projects li span:last-child { color: var(--muted); font-variant-numeric: tabular-nums; }
  /* State machine: show exactly one coached block / the metrics per data-state. */
  .git-value-when-disabled, .git-value-when-empty, .git-value-when-ready { display: none; }
  #git-value-panel[data-state="disabled"] .git-value-when-disabled { display: block; }
  #git-value-panel[data-state="empty"] .git-value-when-empty { display: block; }
  #git-value-panel[data-state="ready"] .git-value-when-ready { display: grid; }
  ```

- [ ] **Step 3: Add `renderGitValue()` + `initGitValueControls()` to `public/app.js`** (place beside `initAlertControls`, after line 1108). `renderGitValue` is surgical (writes `textContent` on the leaf spans + flips `data-state` — never `innerHTML=` on an animated region; the projects `<ul>` is rebuilt but carries no animation, matching how existing tables rebuild). `initGitValueControls` mirrors `initAlertControls`: read `GET /api/config` for the flag, paint the toggle, POST on change, then refetch `/api/git-value` and re-render.
  ```js
  // Code Insights Phase 2: render the Value panel from state.data.gitValue.
  // Surgical — textContent on leaf nodes + a data-state flip; no innerHTML on an
  // animated region (landmine #22). Uses the pure ClaugeDashSwr.gitValueView.
  function renderGitValue() {
    const panel = document.getElementById('git-value-panel');
    if (!panel) return;
    const view =
      (window.ClaugeDashSwr && window.ClaugeDashSwr.gitValueView) ||
      ((p) => ({ enabled: p && p.enabled === true, hasData: false, commits: 0, linesCommitted: 0, costPerCommit: 0, byProject: [] }));
    const v = view(state.data.gitValue);

    const toggle = document.getElementById('git-value-enabled');
    if (toggle && document.activeElement !== toggle) toggle.checked = v.enabled;

    if (!v.enabled) { panel.dataset.state = 'disabled'; return; }
    if (!v.hasData) { panel.dataset.state = 'empty'; return; }
    panel.dataset.state = 'ready';

    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setText('git-value-commits', String(v.commits));
    setText('git-value-lines', v.linesCommitted.toLocaleString());
    setText('git-value-cost', `${v.costPerCommit.toFixed(2)}`);

    const list = document.getElementById('git-value-projects');
    if (list) {
      list.textContent = '';
      for (const p of v.byProject.slice(0, 5)) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = p.project;
        const meta = document.createElement('span');
        meta.textContent = `${p.commits} commits · ${Number(p.linesCommitted).toLocaleString()} lines`;
        li.append(name, meta);
        list.append(li);
      }
    }
  }

  // Opt-in toggle wiring (mirrors initAlertControls). Reads GET /api/config for
  // the current flag, POSTs /api/config/git-value on change, then refetches
  // /api/git-value and re-renders. Plain fetch — same-origin, works in browser
  // mode too. Idempotent init guard.
  let __gitValueInitialized = false;
  const GIT_VALUE_STATUS_CLEAR_MS = 4000;
  function initGitValueControls() {
    if (__gitValueInitialized) return;
    const toggle = document.getElementById('git-value-enabled');
    if (!toggle) return;
    __gitValueInitialized = true;

    const status = document.getElementById('git-value-status');
    let statusTimer = null;
    const showStatus = (text) => {
      if (!status) return;
      status.textContent = text;
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = setTimeout(() => { status.textContent = ''; }, GIT_VALUE_STATUS_CLEAR_MS);
    };

    toggle.addEventListener('change', async () => {
      try {
        const res = await fetch('/api/config/git-value', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: toggle.checked }),
        });
        if (!res.ok) throw new Error(`POST /api/config/git-value → ${res.status}`);
        const git = await api('/api/git-value', commonParams()).catch(() => null);
        state.data.gitValue = git ?? { enabled: toggle.checked };
        renderGitValue();
        showStatus('Saved');
      } catch (err) {
        console.error('git-value toggle failed:', err);
        toggle.checked = !toggle.checked; // revert the optimistic flip
        showStatus('Save failed — not stored');
      }
    });

    // Initial paint from /api/config so the toggle reflects the stored flag even
    // before the first /api/git-value lands.
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg && typeof cfg.gitValueEnabled === 'boolean' && document.activeElement !== toggle) {
          toggle.checked = cfg.gitValueEnabled;
          if (!cfg.gitValueEnabled) {
            const panel = document.getElementById('git-value-panel');
            if (panel) panel.dataset.state = 'disabled';
          }
        }
      })
      .catch((err) => console.error('git-value config load failed:', err));
  }
  ```

- [ ] **Step 4: Wire the fetch + render into `refreshAll()`.** In `refreshAll` (line 1401), add a best-effort `/api/git-value` fetch to the `Promise.all` (keep-last-good, like `/api/projection`) and render it. Add the array element after the projection line (line 1425):
  ```js
        api('/api/projection').catch(() => null),
        api('/api/git-value', commonParams()).catch(() => null),
  ```
  Extend the destructure (line 1406) to add `gitValue` at the end:
  ```js
      const [health, summary, cache, sessions, daily, hours, projects, activity, tools, models, usage, expensive, roi, projection, gitValue] =
  ```
  Add it to `state.data` (after `projection: projection ?? state.data.projection,`, line 1430):
  ```js
        projection: projection ?? state.data.projection,
        gitValue: gitValue ?? state.data.gitValue,
  ```
  Call the renderers among the other `render*()` calls (after `renderToolLists();`, line 1446):
  ```js
      renderToolLists();
      renderGitValue();
      initGitValueControls();
  ```
  (`initGitValueControls` is idempotent — the guard makes the repeated call a no-op after the first paint.)

- [ ] **Step 5: Manual verification (UI change needs a real surface — engineering rule #3).** Run the sidecar and drive the panel in a browser (or `/visual-verify`):
  ```bash
  npm run build:sidecar   # only if a served asset changed; here it did (public/*)
  NO_OPEN=1 node server.js   # note the CLAUGE_BOUND_PORT in stderr
  ```
  Open `http://127.0.0.1:<port>`, go to Code Insights. Confirm: (a) toggle OFF → coached opt-in copy, no metrics; (b) toggle ON → panel refetches, shows the empty state or metrics; (c) a repo where you committed during a session shows a non-zero commits count; (d) toggling OFF again returns to the coached state and `~/.clauge/config.json` shows `"gitValueEnabled": false`. Verify no console errors and (DevTools MutationObserver) that a steady 60s auto-refresh does NOT rewrite `innerHTML` on the panel value nodes (landmine #22).

- [ ] **Step 6: Full gate + commit.** `npm run check` (green) AND `npm run test:sea` (a served asset changed — landmine #39 belt-and-braces; expected: no new file was added to the manifests because we only EDITED existing served files, so this passes unchanged — confirm). Then:
  ```bash
  git add public/index.html public/styles.css public/app.js
  git commit -m "feat(git-value): dashboard Value panel — opt-in toggle + coached states

  Renders commits-during-sessions / lines committed / cost-per-commit under Code
  Insights from /api/git-value via the pure gitValueView. Opt-in toggle POSTs
  /api/config/git-value then refetches. Copy states it is read-only correlation,
  NOT per-line attribution. Surgical value updates (landmine #22)."
  ```

---

## Risks / landmines honored

- **#22** auto-refresh must not destroy animated children — the Value panel writes `textContent` on leaf spans + flips `data-state`; the projects `<ul>` rebuild carries no animation.
- **#37 / #42** snapshot schema is a cross-repo contract — `gitValue` is an additive OPTIONAL top-level key, present only when enabled, numbers/array only; `SNAPSHOT_SCHEMA_VERSION` STAYS 1; forecast threading unchanged.
- **Review #26** — no new bare-null typed slot: `costPerCommit` is 0-guarded to `0` (never null), and `gitValue` is omitted entirely when disabled rather than emitted null.
- **#39** no NEW served JS file — the pure helper rides in the already-served `public/swr.js`; the dual-SEA-manifest rule stays dormant. `test:sea` is still run in PR 3 as belt-and-braces.
- **#41** `loadAllSummaries` concurrency cap — Phase 2 rides the existing bounded walk (`loadFiltered` / the snapshot's existing load); it adds NO unbounded pass.
- **#45 (new)** read-only git allowlist + repo path never on the argv — enforced by `test/git-value.test.js`; documented in AGENTS.md.
- **git-value spawns a subprocess** — read-only subcommand allowlist, per-repo error isolation, `execFile` (no shell), timeout-bounded seam; a slow/huge/hostile repo degrades to a skip and never hangs the route.

---

# Code Insights — Phase 3: Reflection view ("How you use Claude Code") — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to run this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every code/test block below is COMPLETE — no placeholders. Read the file you edit with the Read tool BEFORE editing (grep/sed views don't count — engineering-discipline rule #8).

**Goal:** A new **"How you use Claude Code"** reflection section in the desktop dashboard — a heuristic, entirely local mirror of the Reflect-style time/task/pattern slice. It shows **task mix over time**, **when you work** (time-of-day rhythm), and a **time-spent trend**, each over a **1 / 3 / 6 / 12-month** lookback, and publishes the same into the Mac→iPhone snapshot as an additive optional key for Phase 4 (iOS).

**Spec (authoritative):** `docs/superpowers/specs/2026-07-10-code-insights-design.md` (§ "How you use Claude Code", `lib/reflection.js` component, Phase 3 row of the phasing table).

**Architecture:** All new math lives in ONE pure module `lib/reflection.js` (`buildReflection`), which reuses the existing classifier output carried on each session summary (`s.tasks.breakdown`), the existing `rollupByHour` rhythm aggregator, and the existing `s.durationMs` field. A thin Hono route (`GET /api/reflection`) and a snapshot key (`reflection`) wire it up. The dashboard renders three sub-charts behind a local lookback selector, using the established shape-signature + surgical-update pattern (landmine #22).

---

## ⛔ DESIGN INVARIANT — heuristic + local only (read first, never violate)

The reflection engine is **computed, not inferred**. This is a locked brainstorm decision, **not** a performance optimization you may trade away:

- **NO LLM calls, NO API key, NO network.** `lib/reflection.js` imports only `period.js` + `aggregator.js` and touches only in-memory session summaries.
- **NO topic-mining of prompt text.** The only "content" signal is the pre-computed heuristic task **category** (`classifier.js`), never the words the user typed.
- **NO "4D Fluency" / reflective-prompt generation.** Those are Anthropic's proprietary, server-side, LLM-backed layers — explicitly out of scope.

If a future step is tempted to "make the labels smarter" by reading prompt text or calling a model, **stop** — that breaks the invariant and the spec's local/keyless promise. The whole value proposition is that this runs offline against `~/.claude` logs.

---

## PINNED CONTRACT (iOS Phase 4 depends on these EXACT names — do not rename)

```
GET /api/reflection?period=<token>&tz=<IANA>
  → { period, taskMixOverTime, rhythm, durationTrend }

taskMixOverTime : [ { bucketStart: "YYYY-MM-DD",         // day (short lookbacks) or ISO-week-Monday (long)
                      byCategory: { "<Category>": <int turns>, ... } } ]   // only categories with turns>0
rhythm          : [ { hour: 0..23, calls: <int>, cost: <number> } ]        // 24 entries, UTC hours
durationTrend   : [ { bucketStart: "YYYY-MM-DD", durationMs: <int>, sessionCount: <int> } ]

buildReflection(sessions, { period, nowMs, tz }) → { taskMixOverTime, rhythm, durationTrend, lookbackPeriod }

snapshot key `reflection` (additive, schemaVersion STAYS 1):
  { period: "3mo",
    taskMixOverTime: [...≤14 most-recent buckets...],
    durationTrend:   [...≤14 most-recent buckets...],
    rhythm: [ { hour, calls } × 24 ] }              // cost dropped to save phone bytes

NEW period tokens (added to lib/period.js PERIODS + periodStart):  1mo | 3mo | 6mo | 12mo
  semantics: rolling lookback of 30 / 90 / 180 / 365 days (same style as 7d/30d).
```

Categories are the frozen 8 from `lib/classifier.js` `CATEGORIES`: `Testing, Build, GitOps, Coding, Debugging, Exploration, Planning, Conversation`.

---

## House rules in force (every task)

- **ESM** (`"type":"module"`); `lib/` modules are **pure** with the clock injected — `nowMs`/`tz` are always parameters. Never `Date.now()` / bare `new Date()` inside `lib/`. `new Date(nowMs)` and `new Date(iso)` (deterministic conversion of an injected value) are allowed and are the established pattern (`projection.js`, `activity.js`).
- **No `console.log` in `lib/`** (`console.warn/error` OK; none needed here).
- JS tests live at **`test/<name>.test.js`** (landmine #14 — NOT a new directory; landmine #38 — ESM helpers) and run with `node --test <file>`.
- **No new dependencies.**
- **Conventional Commits**; no `Co-Authored-By` trailer.
- Full gate before every merge: **`npm run check`** (validators are a SUBSET; the gate is the whole command — landmine #29). No new served JS file is created (the reflection UI rides the already-registered `public/app.js` + `public/swr.js`), so the SEA-manifest landmine (#2/#39) stays dormant — but if you add a NEW served asset, register BOTH `sea-config.json` and `sea-bootstrap.cjs`.
- **Never push/merge to main directly.** Branch → PR → `gh pr checks --watch` → per-PR squash-merge (use `/ship`).

---

## PR / branch structure

| PR | Branch | Tasks | Contents |
|---|---|---|---|
| 1 | `feat/reflection-lib` | 1–2 | `lib/period.js` lookback-vocabulary extension (`1mo/3mo/6mo/12mo`) + pure `lib/reflection.js` (`buildReflection`) |
| 2 | `feat/reflection-api-snapshot` | 3–4 | `GET /api/reflection` route (+ CORS allowlist entry) + `reflection` snapshot key (compact, additive, schemaVersion stays 1) |
| 3 | `feat/reflection-dashboard` | 5–6 | pure `reflectionView` helper in `public/swr.js` + dashboard "How you use Claude Code" section (markup, styles, render, lookback selector, surgical auto-refresh) |

Each PR: branch from fresh `main` after the previous merges → full `npm run check` locally (needs `npm run build:sidecar` if the sidecar bundle is exercised) → `gh pr create` → `gh pr checks --watch` (branch protection requires `check`) → `gh pr merge --squash`.

**Sequencing:** PR 2 depends on PR 1 (`buildReflection` + the extended period vocabulary). PR 3 depends on PR 2 (`GET /api/reflection`). Tasks within a PR are sequential.

**Key cross-task contracts (pinned):** `buildReflection(sessions, {period, nowMs, tz})` · `PERIODS` now includes `1mo/3mo/6mo/12mo` · `GET /api/reflection` shape above · snapshot `reflection` key · `window.ClaugeDashSwr.reflectionView(reflection)`.

---
## PR 1 — `feat/reflection-lib` (Tasks 1–2)

> Two pure changes: extend the period vocabulary (Task 1), then the reflection engine that consumes it (Task 2). No I/O, no route, no DOM. `buildReflection` reads ONLY fields the aggregator already computes onto each summary (`s.tasks.breakdown`, `s.byHour` via `rollupByHour`, `s.durationMs`, `s.startedAt`) — no re-parsing of raw turns.

---

### Task 1: Extend `lib/period.js` with `1mo / 3mo / 6mo / 12mo` lookback windows

**Files**
- Modify: `/Users/adnanrashid/Projects/clauge/lib/period.js`
- Test: `/Users/adnanrashid/Projects/clauge/test/period.test.js` (extend — currently 80 lines)

**Pinned contract:** `PERIODS` gains `1mo, 3mo, 6mo, 12mo` (inserted before `all`). `isValidPeriod` accepts them. `periodStart(period, now)` returns `now − N days` (N = 30/90/180/365) as an ISO string. All EXISTING tokens/behaviour unchanged (`today/7d/30d/month/all`).

**Steps**

- [ ] **Step 1: Write failing tests.** Append to `test/period.test.js` (after the existing `periodStart` describe, before `withinPeriod`, or at end of file — order is free):

  ```js
  describe('periodStart — reflection lookback windows (Phase 3)', () => {
    // Rolling day-count semantics, same family as 7d/30d.
    it('1mo = now - 30d', () => {
      assert.equal(periodStart('1mo', NOW), '2026-04-06T12:00:00.000Z');
    });
    it('3mo = now - 90d', () => {
      assert.equal(periodStart('3mo', NOW), '2026-02-05T12:00:00.000Z');
    });
    it('6mo = now - 180d', () => {
      assert.equal(periodStart('6mo', NOW), '2025-11-07T12:00:00.000Z');
    });
    it('12mo = now - 365d', () => {
      assert.equal(periodStart('12mo', NOW), '2025-05-06T12:00:00.000Z');
    });
  });

  describe('isValidPeriod — lookback tokens accepted, existing unchanged', () => {
    it('accepts the four new lookback tokens', () => {
      for (const p of ['1mo', '3mo', '6mo', '12mo']) assert.ok(isValidPeriod(p), p);
    });
    it('still rejects garbage and still accepts the originals', () => {
      assert.equal(isValidPeriod('quarter'), false);
      assert.equal(isValidPeriod('2mo'), false);
      for (const p of ['today', '7d', '30d', 'month', 'all']) assert.ok(isValidPeriod(p), p);
    });
  });
  ```

  > The four dates are pre-computed off `NOW = 2026-05-06T12:00:00Z`: −30d=Apr 6, −90d=Feb 5, −180d=Nov 7 2025, −365d=May 6 2025. Verify with `node -e "console.log(new Date(Date.parse('2026-05-06T12:00:00Z') - 90*864e5).toISOString())"` if in doubt.

- [ ] **Step 2: Run — verify FAIL.** `node --test test/period.test.js` → the new blocks fail (`periodStart('1mo', …)` returns `null` today because `1mo` hits the `default` case; `isValidPeriod('1mo')` is `false`).

- [ ] **Step 3: Implement the extension in `lib/period.js`.** Replace the `PERIODS` declaration (line 14) and the `periodStart` function (lines 27–41) with:

  ```js
  // Rolling lookback windows for the Phase-3 reflection view. Kept in ONE map so
  // PERIODS, isValidPeriod and periodStart can't drift. `1mo` deliberately equals
  // a 30-day rolling window (same lower bound as `30d`) — a distinct token so the
  // reflection lookback selector reads as 1/3/6/12 months while reusing the
  // rolling-day semantics of 7d/30d.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const LOOKBACK_DAYS = Object.freeze({ '1mo': 30, '3mo': 90, '6mo': 180, '12mo': 365 });

  export const PERIODS = Object.freeze([
    'today', '7d', '30d', 'month', ...Object.keys(LOOKBACK_DAYS), 'all',
  ]);

  export function isValidPeriod(period) {
    return PERIODS.includes(period);
  }
  ```

  Then update `periodStart` — add the lookback short-circuit at the top of the function body (keep the existing `switch` beneath it unchanged):

  ```js
  export function periodStart(period, now = new Date()) {
    if (period in LOOKBACK_DAYS) {
      return new Date(now.getTime() - LOOKBACK_DAYS[period] * DAY_MS).toISOString();
    }
    switch (period) {
      case 'today': return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      case '7d':   return new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000).toISOString();
      case '30d':  return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      case 'month': {
        const y = now.getUTCFullYear();
        const m = now.getUTCMonth();
        return new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)).toISOString();
      }
      case 'all':
      default:
        return null;
    }
  }
  ```

  > NOTE: `isValidPeriod` already existed at line 16 — the block above *re-declares* `PERIODS`/`isValidPeriod` in one place. Delete the OLD `export const PERIODS = …` (line 14) and OLD `export function isValidPeriod` (lines 16–18) so there is exactly one of each. `withinPeriod`, `matchesProject`, `filterSessions` are untouched.

- [ ] **Step 4: Run — verify PASS.** `node --test test/period.test.js` → all green (old + new).

- [ ] **Step 5: Regression — the whole JS suite must still be green** (period.js is imported widely: server, snapshot, projection). `npm test` → `# fail 0`.

- [ ] **Step 6: Commit.**
  ```bash
  git add lib/period.js test/period.test.js
  git commit -m "feat(period): add 1mo/3mo/6mo/12mo reflection lookback windows"
  ```

---

### Task 2: `lib/reflection.js` — pure reflection engine + fixture tests

**Files**
- Create: `/Users/adnanrashid/Projects/clauge/lib/reflection.js`
- Test: `/Users/adnanrashid/Projects/clauge/test/reflection.test.js`

**Files + Interfaces (new module)**
```
lib/reflection.js  (pure ESM; imports ./period.js, ./aggregator.js)
  export function bucketGranularity(period): 'day' | 'week'
    - 'week' for 3mo/6mo/12mo/all ; 'day' otherwise. Keeps a 12-month array ~52 pts.
  export function buildReflection(sessions, { period, nowMs, tz='UTC' })
    → { taskMixOverTime, rhythm, durationTrend, lookbackPeriod }
    - windows sessions via filterSessions({period, now:new Date(nowMs)})
    - taskMixOverTime: sparse, chronological; byCategory sums s.tasks.breakdown[].turns
    - rhythm: rollupByHour(windowed)  (24 UTC buckets, reused verbatim)
    - durationTrend: per-bucket sum of finite s.durationMs + sessionCount
    - lookbackPeriod: echoes `period`
```

**Pinned contract (do not deviate):** see the top-level PINNED CONTRACT block. `taskMixOverTime` omits buckets with zero classified turns and omits zero-count categories (compact, no bare-null/zero slots — review #26). `durationTrend` keeps every bucket that has ≥1 session (so "time spent" shows even a day of pure conversation with no task turns). Buckets sort chronologically by `bucketStart` (YYYY-MM-DD lexicographic = chronological). `null`/empty input → all-empty arrays, never throws.

**Steps**

- [ ] **Step 1: Write the failing test file `test/reflection.test.js`.** Complete file:

  ```js
  // Unit tests for lib/reflection.js — pure, heuristic, LOCAL reflection engine
  // (Code Insights Phase 3, docs/superpowers/specs/2026-07-10-code-insights-design.md).
  // Clock injected via NOW_MS; no LLM, no network — the module imports only
  // period.js + aggregator.js. Fixtures are session SUMMARIES (summarizeSession
  // output), carrying the exact fields buildReflection reads.

  import { describe, it } from 'node:test';
  import assert from 'node:assert/strict';
  import { buildReflection, bucketGranularity } from '../lib/reflection.js';

  // 2026-06-15T12:00:00Z — a Monday-anchored clock family for deterministic buckets.
  const NOW_MS = Date.parse('2026-06-15T12:00:00.000Z');
  const HOUR_MS = 60 * 60 * 1000;

  /** Minimal session summary with only the fields buildReflection reads. */
  function makeSession({ startedAt, durationMs = HOUR_MS, tasks = null, byHour = null }) {
    return {
      startedAt,
      endedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(),
      durationMs,
      // s.tasks.breakdown is the classifier rollup carried on every summary.
      tasks: tasks
        ? { primary: tasks[0]?.category ?? null, total: tasks.reduce((s, t) => s + t.turns, 0), breakdown: tasks }
        : { primary: null, total: 0, breakdown: [] },
      // s.byHour is the 24-slot per-session hour histogram rollupByHour reads.
      byHour: byHour ?? new Array(24).fill(0).map(() => ({ calls: 0, cost: 0 })),
    };
  }

  /** byHour array with `calls` at one UTC hour. */
  function hourAt(h, calls) {
    const arr = new Array(24).fill(0).map(() => ({ calls: 0, cost: 0 }));
    arr[h] = { calls, cost: 0 };
    return arr;
  }

  describe('bucketGranularity', () => {
    it('day for short lookbacks', () => {
      for (const p of ['today', '7d', '30d', 'month', '1mo']) {
        assert.equal(bucketGranularity(p), 'day', p);
      }
    });
    it('week for long lookbacks', () => {
      for (const p of ['3mo', '6mo', '12mo', 'all']) {
        assert.equal(bucketGranularity(p), 'week', p);
      }
    });
  });

  describe('buildReflection — empty / guard inputs', () => {
    it('null sessions -> all-empty arrays, echoes lookbackPeriod', () => {
      const r = buildReflection(null, { period: '3mo', nowMs: NOW_MS, tz: 'UTC' });
      assert.deepEqual(r.taskMixOverTime, []);
      assert.deepEqual(r.durationTrend, []);
      assert.equal(r.rhythm.length, 24);
      assert.ok(r.rhythm.every((h) => h.calls === 0));
      assert.equal(r.lookbackPeriod, '3mo');
    });

    it('sessions outside the lookback window are excluded', () => {
      const sessions = [
        makeSession({ startedAt: '2025-01-01T10:00:00Z', tasks: [{ category: 'Coding', turns: 5 }] }),
      ];
      const r = buildReflection(sessions, { period: '1mo', nowMs: NOW_MS, tz: 'UTC' });
      assert.deepEqual(r.taskMixOverTime, []);
      assert.deepEqual(r.durationTrend, []);
    });
  });

  describe('taskMixOverTime — day buckets (short lookback)', () => {
    it('sums turns per category per day, sparse + chronological', () => {
      const sessions = [
        makeSession({ startedAt: '2026-06-14T09:00:00Z', tasks: [{ category: 'Coding', turns: 3 }, { category: 'Testing', turns: 1 }] }),
        makeSession({ startedAt: '2026-06-14T20:00:00Z', tasks: [{ category: 'Coding', turns: 2 }] }),
        makeSession({ startedAt: '2026-06-15T08:00:00Z', tasks: [{ category: 'Debugging', turns: 4 }] }),
      ];
      const r = buildReflection(sessions, { period: '30d', nowMs: NOW_MS, tz: 'UTC' });
      assert.deepEqual(r.taskMixOverTime, [
        { bucketStart: '2026-06-14', byCategory: { Coding: 5, Testing: 1 } },
        { bucketStart: '2026-06-15', byCategory: { Debugging: 4 } },
      ]);
    });

    it('omits a bucket with zero classified turns (but durationTrend keeps it)', () => {
      const sessions = [
        makeSession({ startedAt: '2026-06-15T08:00:00Z', durationMs: 2 * HOUR_MS, tasks: [] }),
      ];
      const r = buildReflection(sessions, { period: '30d', nowMs: NOW_MS, tz: 'UTC' });
      assert.deepEqual(r.taskMixOverTime, []);
      assert.deepEqual(r.durationTrend, [
        { bucketStart: '2026-06-15', durationMs: 2 * HOUR_MS, sessionCount: 1 },
      ]);
    });
  });

  describe('taskMixOverTime — week buckets (long lookback, ISO Monday)', () => {
    it('collapses days into their ISO-week Monday', () => {
      // 2026-06-10 (Wed) and 2026-06-14 (Sun) both belong to week starting Mon 2026-06-08.
      const sessions = [
        makeSession({ startedAt: '2026-06-10T09:00:00Z', tasks: [{ category: 'Coding', turns: 2 }] }),
        makeSession({ startedAt: '2026-06-14T09:00:00Z', tasks: [{ category: 'Coding', turns: 3 }] }),
      ];
      const r = buildReflection(sessions, { period: '3mo', nowMs: NOW_MS, tz: 'UTC' });
      assert.deepEqual(r.taskMixOverTime, [
        { bucketStart: '2026-06-08', byCategory: { Coding: 5 } },
      ]);
    });
  });

  describe('rhythm — reuses rollupByHour (24 UTC buckets)', () => {
    it('aggregates per-session byHour into the 24-slot histogram', () => {
      const sessions = [
        makeSession({ startedAt: '2026-06-14T09:00:00Z', byHour: hourAt(9, 4) }),
        makeSession({ startedAt: '2026-06-15T09:00:00Z', byHour: hourAt(9, 2) }),
        makeSession({ startedAt: '2026-06-15T22:00:00Z', byHour: hourAt(22, 1) }),
      ];
      const r = buildReflection(sessions, { period: '30d', nowMs: NOW_MS, tz: 'UTC' });
      assert.equal(r.rhythm.length, 24);
      assert.equal(r.rhythm[9].calls, 6);
      assert.equal(r.rhythm[22].calls, 1);
      assert.equal(r.rhythm[0].calls, 0);
    });
  });

  describe('durationTrend — sums finite durationMs per bucket', () => {
    it('ignores non-finite durations but still counts the session', () => {
      const sessions = [
        makeSession({ startedAt: '2026-06-15T08:00:00Z', durationMs: 3 * HOUR_MS, tasks: [{ category: 'Coding', turns: 1 }] }),
        { startedAt: '2026-06-15T12:00:00Z', durationMs: null, tasks: { breakdown: [{ category: 'Coding', turns: 1 }] }, byHour: null },
      ];
      const r = buildReflection(sessions, { period: '30d', nowMs: NOW_MS, tz: 'UTC' });
      assert.deepEqual(r.durationTrend, [
        { bucketStart: '2026-06-15', durationMs: 3 * HOUR_MS, sessionCount: 2 },
      ]);
    });
  });

  describe('tz bucketing — day key follows the requested timezone', () => {
    it('a 22:00Z session on Jun-14 buckets to Jun-15 in Asia/Dhaka (+6)', () => {
      const sessions = [
        makeSession({ startedAt: '2026-06-14T22:00:00Z', tasks: [{ category: 'Coding', turns: 1 }] }),
      ];
      const utc = buildReflection(sessions, { period: '30d', nowMs: NOW_MS, tz: 'UTC' });
      assert.equal(utc.taskMixOverTime[0].bucketStart, '2026-06-14');
      const dhaka = buildReflection(sessions, { period: '30d', nowMs: NOW_MS, tz: 'Asia/Dhaka' });
      assert.equal(dhaka.taskMixOverTime[0].bucketStart, '2026-06-15');
    });
  });
  ```

- [ ] **Step 2: Run — verify FAIL.** `node --test test/reflection.test.js` → `Cannot find module '../lib/reflection.js'` (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Implement `lib/reflection.js`.** Complete file:

  ```js
  /**
   * Reflection view — "How you use Claude Code" (Code Insights, Phase 3).
   * Spec: docs/superpowers/specs/2026-07-10-code-insights-design.md
   *
   * PURE, HEURISTIC, LOCAL. This is a DESIGN INVARIANT, not an optimization:
   * no LLM, no API key, no network, no topic-mining of prompt text. Every number
   * is COMPUTED from local session summaries, never inferred. The module imports
   * ONLY period.js + aggregator.js and reads only fields the aggregator already
   * computed onto each summary:
   *   - s.tasks.breakdown  (classifier categories)   -> taskMixOverTime
   *   - s.byHour (via rollupByHour)                  -> rhythm
   *   - s.durationMs                                 -> durationTrend
   *
   * Clock injected: nowMs + tz are parameters (house rule — no Date.now()/bare
   * new Date() in lib/). new Date(nowMs)/new Date(iso) are deterministic
   * conversions of injected values, the same pattern projection.js/activity.js use.
   */

  import { filterSessions } from './period.js';
  import { rollupByHour } from './aggregator.js';

  // Day buckets for short lookbacks; week buckets for long ones so a 12-month
  // series stays ~52 points (phone-sized) instead of ~365.
  const WEEK_BUCKET_PERIODS = new Set(['3mo', '6mo', '12mo', 'all']);

  /** @param {string} period @returns {'day'|'week'} */
  export function bucketGranularity(period) {
    return WEEK_BUCKET_PERIODS.has(period) ? 'week' : 'day';
  }

  /** YYYY-MM-DD for an ISO timestamp in `tz` (en-CA is always YYYY-MM-DD). Mirrors activity.js. */
  function dateInTz(iso, tz) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  }

  /**
   * ISO-week Monday of a YYYY-MM-DD, as YYYY-MM-DD. Pure UTC calendar math so DST
   * never shifts the calendar (mirrors activity.js shiftDay). Sunday belongs to
   * the week that started the previous Monday.
   */
  function weekStart(yyyymmdd) {
    const d = new Date(`${yyyymmdd}T00:00:00Z`);
    const dow = d.getUTCDay(); // 0=Sun .. 6=Sat
    const delta = dow === 0 ? -6 : 1 - dow; // shift back to Monday
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  function bucketKey(iso, tz, granularity) {
    const day = dateInTz(iso, tz);
    if (day == null) return null;
    return granularity === 'week' ? weekStart(day) : day;
  }

  /**
   * Build the reflection view over a lookback window.
   *
   * @param {Array} sessions session summaries (summarizeSession output)
   * @param {{ period: string, nowMs: number, tz?: string }} opts
   * @returns {{ taskMixOverTime: Array<{bucketStart:string, byCategory:Object}>,
   *            rhythm: Array<{hour:number, calls:number, cost:number}>,
   *            durationTrend: Array<{bucketStart:string, durationMs:number, sessionCount:number}>,
   *            lookbackPeriod: string }}
   */
  export function buildReflection(sessions, { period, nowMs, tz = 'UTC' } = {}) {
    const windowed = filterSessions(sessions, { period, now: new Date(nowMs) });
    const granularity = bucketGranularity(period);

    // Single pass: bucketStart -> { byCategory, durationMs, sessionCount }.
    const buckets = new Map();
    for (const s of windowed) {
      if (!s?.startedAt) continue;
      const key = bucketKey(s.startedAt, tz, granularity);
      if (key == null) continue;
      const b = buckets.get(key) ?? { byCategory: {}, durationMs: 0, sessionCount: 0 };
      for (const item of s.tasks?.breakdown ?? []) {
        if (!item?.category) continue;
        b.byCategory[item.category] = (b.byCategory[item.category] ?? 0) + (item.turns ?? 0);
      }
      if (Number.isFinite(s.durationMs)) b.durationMs += Math.max(0, s.durationMs);
      b.sessionCount += 1;
      buckets.set(key, b);
    }

    // YYYY-MM-DD sorts lexicographically = chronologically.
    const orderedKeys = [...buckets.keys()].sort();

    const taskMixOverTime = orderedKeys
      .map((k) => ({ bucketStart: k, byCategory: buckets.get(k).byCategory }))
      .filter((x) => Object.keys(x.byCategory).length > 0);

    const durationTrend = orderedKeys.map((k) => {
      const b = buckets.get(k);
      return { bucketStart: k, durationMs: b.durationMs, sessionCount: b.sessionCount };
    });

    return {
      taskMixOverTime,
      rhythm: rollupByHour(windowed),
      durationTrend,
      lookbackPeriod: period,
    };
  }
  ```

- [ ] **Step 4: Run — verify PASS.** `node --test test/reflection.test.js` → all green.

- [ ] **Step 5: Full JS suite.** `npm test` → `# fail 0`.

- [ ] **Step 6: Commit.**
  ```bash
  git add lib/reflection.js test/reflection.test.js
  git commit -m "feat(reflection): pure heuristic reflection engine (task-mix/rhythm/duration over lookback)"
  ```

- [ ] **Step 7: Open PR 1.** `gh pr create -t "feat: reflection engine + lookback periods (Code Insights Phase 3, PR 1)" -b "…"` → `gh pr checks --watch` → after green + review, `gh pr merge --squash`.

---
## PR 2 — `feat/reflection-api-snapshot` (Tasks 3–4, after PR 1 merges)

> **Preconditions on `main`:** `lib/reflection.js` (`buildReflection`, `bucketGranularity`) and `lib/period.js` accepting `1mo/3mo/6mo/12mo`. Task 3 wires the route; Task 4 wires the snapshot key.

---

### Task 3: `GET /api/reflection` route

**Why:** The dashboard (PR 3) and any local tool read the reflection view over loopback. Mirrors the existing read-only `/api/*` handlers: parse `period` (its own default `3mo` — reflection is a long-lookback surface, not the 7d default) + `tz`, validate via `isValidPeriod`, capture ONE `nowMs`, load all summaries, delegate to the pure `buildReflection`, return the pinned shape. The webview loads from a loopback origin, so the path MUST be added to `READ_ONLY_API_PATHS` (so the reflecting-allowlist CORS covers it) — unlike the loopback-only alert endpoints.

**Files**
- Modify: `/Users/adnanrashid/Projects/clauge/server.js` — add import; add `/api/reflection` to `READ_ONLY_API_PATHS`; add the handler.
- Create/Test: `/Users/adnanrashid/Projects/clauge/test/server-reflection.test.js` (spawns the real server, server-additions style).

**Steps**

- [ ] **Step 1: Write the failing `test/server-reflection.test.js`.** Complete file:

  ```js
  // Integration tests for GET /api/reflection (Code Insights Phase 3). Spawns the
  // real Hono server. Engine MATH is covered by test/reflection.test.js; these
  // assert only endpoint plumbing: the {period, taskMixOverTime, rhythm,
  // durationTrend} shape, period validation (incl. the new lookback tokens), the
  // 3mo default, and CORS reachability from a loopback origin. Sandbox ~/.claude
  // via HOME + ~/.clauge via CLAUGE_HOME (empty trees -> empty reflection).

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

  describe('GET /api/reflection — shape + validation', () => {
    let server, home;
    const PORT = '3560';
    const BASE = `http://127.0.0.1:${PORT}`;

    before(async () => {
      home = await mkdtemp(`${tmpdir()}/clauge-reflection-`);
      server = await startServer({ PORT, CLAUGE_HOME: home, HOME: home });
    });

    after(async () => {
      if (server && !server.killed) {
        server.kill('SIGTERM');
        await new Promise((r) => server.once('exit', r));
      }
      await rm(home, { recursive: true, force: true });
    });

    it('returns { period, taskMixOverTime, rhythm, durationTrend } with a 24-slot rhythm', async () => {
      const res = await fetch(`${BASE}/api/reflection`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(Object.keys(body).sort(), ['durationTrend', 'period', 'rhythm', 'taskMixOverTime']);
      assert.equal(body.period, '3mo', 'defaults to the 3mo lookback');
      assert.ok(Array.isArray(body.taskMixOverTime));
      assert.ok(Array.isArray(body.durationTrend));
      assert.ok(Array.isArray(body.rhythm));
      assert.equal(body.rhythm.length, 24, 'rhythm is always the full 24-hour histogram');
      for (const h of body.rhythm) {
        for (const k of ['hour', 'calls', 'cost']) assert.ok(k in h, `rhythm entry carries ${k}`);
      }
    });

    it('accepts the new lookback tokens and echoes them', async () => {
      for (const p of ['1mo', '3mo', '6mo', '12mo']) {
        const body = await (await fetch(`${BASE}/api/reflection?period=${p}`)).json();
        assert.equal(body.period, p);
      }
    });

    it('rejects an invalid period with 400', async () => {
      const res = await fetch(`${BASE}/api/reflection?period=quarter`);
      assert.equal(res.status, 400);
    });

    it('is reachable cross-origin from a loopback origin (read-only CORS allowlist)', async () => {
      const res = await fetch(`${BASE}/api/reflection`, {
        headers: { Origin: 'http://localhost:9999' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:9999');
    });
  });
  ```

- [ ] **Step 2: Run — verify FAIL.** `node --test test/server-reflection.test.js` → the route 404s (shape + status assertions fail; the CORS header is absent).

- [ ] **Step 3: Add the import.** In `server.js`, next to the other lib imports (after the `buildSnapshot` import, line 39), add:

  ```js
  import { buildReflection } from './lib/reflection.js';
  ```

- [ ] **Step 4: Add `/api/reflection` to the read-only CORS allowlist.** In the `READ_ONLY_API_PATHS` array (around line 186), add the entry (place it after `'/api/projection'`):

  ```js
    '/api/projection',
    '/api/reflection',
  ```

- [ ] **Step 5: Add the handler.** Insert immediately after the `GET /api/tasks` handler (after line 450) — it belongs with the other read aggregations. `period` defaults to `3mo`; capture one `nowMs`; pass ALL summaries (buildReflection windows internally):

  ```js
  // Reflection view — "How you use Claude Code" (Code Insights Phase 3). Pure
  // math lives in lib/reflection.js (heuristic + local, NO LLM). Its own default
  // lookback is 3mo (a long-window surface, not the 7d default). ONE nowMs is
  // injected here and threaded into buildReflection (which windows sessions +
  // buckets by tz). Read-only, loopback-CORS-covered (in READ_ONLY_API_PATHS).
  app.get('/api/reflection', async (c) => {
    const period = c.req.query('period') ?? '3mo';
    if (!isValidPeriod(period)) {
      return c.json({ error: `invalid period: ${period}` }, 400);
    }
    const tz = c.req.query('tz') ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    const nowMs = Date.now();
    const all = await store.loadAllSummaries();
    const { taskMixOverTime, rhythm, durationTrend } = buildReflection(all, { period, nowMs, tz });
    return c.json({ period, taskMixOverTime, rhythm, durationTrend });
  });
  ```

  > `isValidPeriod` is already imported (line 29). No new import beyond `buildReflection`.

- [ ] **Step 6: Run — verify PASS.** `node --test test/server-reflection.test.js` → all green. Then `node --test test/server-additions.test.js` and `node --test test/server-projection.test.js` → still green (the new handler + allowlist entry are additive; CORS wiring undisturbed).

- [ ] **Step 7: Validators.** `npm run check:validators` (or `npm run check` if you want the whole gate now) — confirm the CORS/console-log/port validators still pass (a new read-only path is expected by the allowlist).

- [ ] **Step 8: Commit.**
  ```bash
  git add server.js test/server-reflection.test.js
  git commit -m "feat(reflection): GET /api/reflection route (loopback read-only CORS)"
  ```

---

### Task 4: Snapshot `reflection` key (additive, compact, schemaVersion stays 1)

**Why:** The Mac publishes the reflection view into its iCloud snapshot so Phase 4 (iOS) can surface it WITHOUT a schema bump. This is an **additive optional key** — landmine #37: `SNAPSHOT_SCHEMA_VERSION` MUST stay `1`, old iOS ignores unknown keys, a premature bump blanks every iPhone's Analytics tab. Keep it phone-sized (mirror `buildActivity`/`buildForecastHistory` trimming): a compact **`3mo`** view, buckets capped to the most-recent 14, rhythm trimmed to `{hour, calls}`. **No bare-null typed slots** (review #26) — every field is an array/object, never `null`.

**Files**
- Modify: `/Users/adnanrashid/Projects/clauge/lib/snapshot.js`
- Test: `/Users/adnanrashid/Projects/clauge/test/snapshot.test.js` (extend — currently 247 lines)

**Steps**

- [ ] **Step 1: Write failing tests.** Append to `test/snapshot.test.js` (after the forecast-block describe, before the payload-tripwire describe, or at end):

  ```js
  // Phase 3: the `reflection` block is an ADDITIVE optional key (schemaVersion
  // stays 1 — landmine #37). Compact: a 3mo view, buckets capped to the most-
  // recent 14, rhythm trimmed to {hour, calls}. No bare-null typed slots.
  describe('buildSnapshot — reflection block (Code Insights Phase 3)', () => {
    const NOW_MS = NOW.getTime();
    const HOUR = 60 * 60 * 1000;

    /** Session summary carrying the fields buildReflection reads. */
    function reflectSession({ startedAt, durationMs = HOUR, category = 'Coding', turns = 2, hour = 9, calls = 3 }) {
      const byHour = new Array(24).fill(0).map(() => ({ calls: 0, cost: 0 }));
      byHour[hour] = { calls, cost: 0 };
      return {
        ...makeSession({ startedAt, cost: 1 }),
        durationMs,
        tasks: { primary: category, total: turns, breakdown: [{ category, turns, pct: 1 }] },
        byHour,
      };
    }

    it('emits reflection with the pinned shape and schemaVersion still 1', async () => {
      const snap = await build([
        reflectSession({ startedAt: '2026-06-02T09:00:00Z' }),
        reflectSession({ startedAt: '2026-06-04T09:00:00Z', category: 'Testing' }),
      ]);
      assert.equal(snap.schemaVersion, 1);
      assert.ok('reflection' in snap, 'reflection ships as an optional key under schemaVersion 1');
      assert.equal(snap.reflection.period, '3mo');
      assert.ok(Array.isArray(snap.reflection.taskMixOverTime));
      assert.ok(Array.isArray(snap.reflection.durationTrend));
      assert.equal(snap.reflection.rhythm.length, 24);
      // rhythm trimmed to {hour, calls} (cost dropped for phone bytes).
      for (const h of snap.reflection.rhythm) {
        assert.deepEqual(Object.keys(h).sort(), ['calls', 'hour']);
      }
    });

    it('degrades to empty arrays (never null) with no sessions', async () => {
      const snap = await build([]);
      assert.deepEqual(snap.reflection.taskMixOverTime, []);
      assert.deepEqual(snap.reflection.durationTrend, []);
      assert.equal(snap.reflection.rhythm.length, 24);
    });

    it('caps taskMixOverTime + durationTrend to the 14 most-recent buckets', async () => {
      // 20 distinct days -> 20 day buckets in a 3mo lookback; only the newest 14 survive.
      const sessions = Array.from({ length: 20 }, (_, i) => {
        const day = String(i + 1).padStart(2, '0');
        return reflectSession({ startedAt: `2026-05-${day}T09:00:00Z` });
      });
      const snap = await build(sessions);
      assert.ok(snap.reflection.taskMixOverTime.length <= 14);
      assert.ok(snap.reflection.durationTrend.length <= 14);
      // Kept buckets are the most-recent (chronological tail).
      const last = snap.reflection.durationTrend.at(-1).bucketStart;
      assert.equal(last, '2026-05-20');
    });
  });
  ```

- [ ] **Step 2: Run — verify FAIL.** `node --test test/snapshot.test.js` → new block fails (`snap.reflection` is `undefined`).

- [ ] **Step 3: Implement in `lib/snapshot.js`.** Add the import beside the other lib imports (after the `RECENT_SPAN_MS` import, line 28):

  ```js
  import { buildReflection } from './reflection.js';
  ```

  Add the constants near the other snapshot constants (after `MAX_TOOLS_PER_GROUP`, line 53):

  ```js
  /** Reflection snapshot lookback (its own long window, independent of DEFAULT_PERIOD). */
  const REFLECTION_PERIOD = '3mo';
  /** Cap reflection series to the most-recent N buckets (phone-sized, mirrors buildActivity trimming). */
  const MAX_REFLECTION_BUCKETS = 14;
  ```

  Add the builder near `buildActivity` (after line 254):

  ```js
  /**
   * Compact reflection block (Code Insights Phase 3) for the phone snapshot.
   * Additive optional key — schemaVersion STAYS 1 (landmine #37). Runs the pure
   * buildReflection over a 3mo lookback, then trims: series to the most-recent
   * MAX_REFLECTION_BUCKETS, rhythm to {hour, calls} (cost dropped for bytes).
   * Every field is an array/object — never bare null (review #26).
   */
  function buildReflectionSnapshot(allSessions, nowMs, tz) {
    const r = buildReflection(allSessions, { period: REFLECTION_PERIOD, nowMs, tz });
    const tail = (arr) => arr.slice(-MAX_REFLECTION_BUCKETS);
    return {
      period: REFLECTION_PERIOD,
      taskMixOverTime: tail(r.taskMixOverTime),
      durationTrend: tail(r.durationTrend),
      rhythm: r.rhythm.map((h) => ({ hour: h.hour, calls: h.calls })),
    };
  }
  ```

  Finally, add the key to the returned snapshot object in `buildSnapshot` (in the `return { … }` block, after the `forecast:` line, before the closing brace, ~line 318). ONE clock — reuse `now.getTime()` (the same `now` the rest of the snapshot uses):

  ```js
      // Phase 3 (optional, schemaVersion stays 1): compact reflection view over a
      // 3mo lookback (task-mix-over-time + rhythm + time-spent trend). Heuristic +
      // local (no LLM). Trimmed to phone size; empty arrays, never null.
      reflection: buildReflectionSnapshot(allSessions, now.getTime(), tz),
  ```

- [ ] **Step 4: Run — verify PASS.** `node --test test/snapshot.test.js` → all green, INCLUDING the existing **18KB payload tripwire** (reflection with real data adds ~1–2 KB; the ceiling has headroom, but confirm the tripwire test still passes — if it now fails, the cap/trim is the lever, not the ceiling).

- [ ] **Step 5: Full JS suite + the snapshot-forecast server test.** `npm test` → `# fail 0`. Also `node --test test/server-snapshot-forecast.test.js` (the snapshot is served via `/api/snapshot`).

- [ ] **Step 6: Commit.**
  ```bash
  git add lib/snapshot.js test/snapshot.test.js
  git commit -m "feat(snapshot): additive reflection key (compact 3mo view, schemaVersion stays 1)"
  ```

- [ ] **Step 7: Open PR 2**, `gh pr checks --watch`, review, squash-merge.

---
## PR 3 — `feat/reflection-dashboard` (Tasks 5–6, after PR 2 merges)

> **Preconditions on `main`:** `GET /api/reflection` returns the pinned shape. Task 5 adds the one pure, vm-testable seam (`reflectionView` in `public/swr.js`); Task 6 wires the dashboard section that consumes it.
>
> **No new served file** — the reflection UI rides the already-SEA-registered `public/app.js` + `public/swr.js` + `public/index.html` + `public/styles.css`, so landmine #39 stays dormant. The dashboard is outside the popover copy registry (`scripts/validate-copy-registry.cjs` scans `popover/` only), so inline English strings are fine here. UI-layer changes are NOT done until exercised in a real browser (engineering-discipline rule #3 — `/visual-verify`).

---

### Task 5: Pure `reflectionView(reflection)` helper in `public/swr.js`

**Why:** The render code needs stacked-bar segments (per bucket, ordered by category, with each category's share of the bucket), plus rhythm/trend maxima for bar scaling, plus an emptiness flag. That mapping is pure and belongs in the established vm-testable IIFE (`public/swr.js`, tested by `test/dashboard-swr.test.js`) — NOT tangled into the DOM code. Localization of hours stays in `app.js` (it already has `utcHoursToLocal`).

**Files + Interfaces (helper)**
```
window.ClaugeDashSwr.reflectionView(reflection) → {
  isEmpty:  boolean,                       // no task buckets AND rhythm all-zero AND trend all-zero
  buckets:  [ { bucketStart, total, segments: [ { category, turns, pct } ] } ],  // category-ordered, pct of bucket
  rhythm:   [ { hour, calls } ],           // pass-through (24), calls coerced to finite
  rhythmMax: number,                       // max(1, …calls) for bar scaling
  trend:    [ { bucketStart, durationMs, sessionCount } ],
  trendMax:  number,                       // max(1, …durationMs) for bar scaling
}
```

**Files**
- Modify: `/Users/adnanrashid/Projects/clauge/public/swr.js`
- Test: `/Users/adnanrashid/Projects/clauge/test/dashboard-swr.test.js` (extend — the vm loader pattern already destructures `window.ClaugeDashSwr`)

**Steps**

- [ ] **Step 1: Write failing tests.** First extend the destructure line in `test/dashboard-swr.test.js` (the `loadDashSwr()` destructure near line 25) to pull the new helper:

  ```js
  const { syncMeta, shouldSkipTick, alertPrefsView, reflectionView } = loadDashSwr();
  ```

  Then append a describe block:

  ```js
  describe('reflectionView — /api/reflection -> render view model', () => {
    it('flags empty when there is no task/rhythm/duration activity', () => {
      const v = reflectionView({ taskMixOverTime: [], rhythm: [], durationTrend: [] });
      assert.equal(v.isEmpty, true);
      assert.deepEqual(v.buckets, []);
      assert.equal(v.rhythmMax, 1);
      assert.equal(v.trendMax, 1);
    });

    it('tolerates a null / garbage payload (fails safe to empty)', () => {
      const v = reflectionView(null);
      assert.equal(v.isEmpty, true);
      assert.deepEqual(v.buckets, []);
      assert.equal(v.rhythm.length, 0);
    });

    it('orders segments by the classifier category order and computes pct of the bucket', () => {
      const v = reflectionView({
        taskMixOverTime: [
          { bucketStart: '2026-06-14', byCategory: { Debugging: 1, Coding: 3 } },
        ],
        rhythm: [{ hour: 9, calls: 4, cost: 0 }],
        durationTrend: [{ bucketStart: '2026-06-14', durationMs: 3600000, sessionCount: 1 }],
      });
      assert.equal(v.isEmpty, false);
      assert.equal(v.buckets.length, 1);
      const b = v.buckets[0];
      assert.equal(b.total, 4);
      // Coding (order 4) precedes Debugging (order 5); pct is share of bucket total.
      assert.deepEqual(b.segments.map((s) => s.category), ['Coding', 'Debugging']);
      assert.ok(Math.abs(b.segments[0].pct - 0.75) < 1e-9);
      assert.ok(Math.abs(b.segments[1].pct - 0.25) < 1e-9);
    });

    it('exposes maxima for bar scaling (>=1) and passes rhythm through', () => {
      const v = reflectionView({
        taskMixOverTime: [],
        rhythm: [{ hour: 9, calls: 6, cost: 0 }, { hour: 10, calls: 2, cost: 0 }],
        durationTrend: [{ bucketStart: '2026-06-14', durationMs: 7200000, sessionCount: 2 }],
      });
      assert.equal(v.rhythmMax, 6);
      assert.equal(v.trendMax, 7200000);
      assert.deepEqual(v.rhythm, [{ hour: 9, calls: 6 }, { hour: 10, calls: 2 }]);
      assert.equal(v.isEmpty, false, 'rhythm/trend activity alone is not empty');
    });
  });
  ```

- [ ] **Step 2: Run — verify FAIL.** `node --test test/dashboard-swr.test.js` → `reflectionView is not a function` on the new block.

- [ ] **Step 3: Implement in `public/swr.js`.** Add inside the IIFE, after `alertPrefsView` (before the `window.ClaugeDashSwr = …` assignment):

  ```js
  // ── Reflection view mapping (Code Insights Phase 3) ─────────────────────
  // Pure: /api/reflection payload -> render view model. Category order mirrors
  // lib/classifier.js CATEGORIES (kept in sync by hand — this classic <script>
  // can't import ESM). Stacked-bar segments are ordered + carry each category's
  // share of the bucket; maxima (>=1) scale the rhythm + duration bars. Fails
  // safe to an empty view on a null/garbage payload.
  const REFLECT_CATEGORY_ORDER = [
    'Testing', 'Build', 'GitOps', 'Coding',
    'Debugging', 'Exploration', 'Planning', 'Conversation',
  ];

  function reflectionView(reflection) {
    const r = reflection && typeof reflection === 'object' ? reflection : {};
    const taskMix = Array.isArray(r.taskMixOverTime) ? r.taskMixOverTime : [];
    const rawRhythm = Array.isArray(r.rhythm) ? r.rhythm : [];
    const rawTrend = Array.isArray(r.durationTrend) ? r.durationTrend : [];

    const buckets = taskMix.map((b) => {
      const by = b && typeof b.byCategory === 'object' && b.byCategory ? b.byCategory : {};
      const total = REFLECT_CATEGORY_ORDER.reduce((s, c) => s + (by[c] ?? 0), 0);
      const segments = REFLECT_CATEGORY_ORDER
        .filter((c) => (by[c] ?? 0) > 0)
        .map((c) => ({ category: c, turns: by[c], pct: total === 0 ? 0 : by[c] / total }));
      return { bucketStart: b.bucketStart, total, segments };
    });

    const rhythm = rawRhythm.map((h) => ({
      hour: h.hour,
      calls: Number.isFinite(h.calls) ? h.calls : 0,
    }));
    const trend = rawTrend.map((t) => ({
      bucketStart: t.bucketStart,
      durationMs: Number.isFinite(t.durationMs) ? t.durationMs : 0,
      sessionCount: Number.isFinite(t.sessionCount) ? t.sessionCount : 0,
    }));

    const rhythmSum = rhythm.reduce((s, h) => s + h.calls, 0);
    const trendSum = trend.reduce((s, t) => s + t.durationMs, 0);
    const rhythmMax = Math.max(1, ...rhythm.map((h) => h.calls));
    const trendMax = Math.max(1, ...trend.map((t) => t.durationMs));

    return {
      isEmpty: buckets.length === 0 && rhythmSum === 0 && trendSum === 0,
      buckets,
      rhythm,
      rhythmMax,
      trend,
      trendMax,
    };
  }
  ```

  Extend the export at the bottom of the IIFE:

  ```js
    if (typeof window !== 'undefined') {
      window.ClaugeDashSwr = { syncMeta, shouldSkipTick, projectionLine, wowLine, paceLine, alertPrefsView, reflectionView };
    }
  ```

- [ ] **Step 4: Run — verify PASS.** `node --test test/dashboard-swr.test.js` → all green.

- [ ] **Step 5: Commit.**
  ```bash
  git add public/swr.js test/dashboard-swr.test.js
  git commit -m "feat(dashboard): pure reflectionView helper for the reflection section"
  ```

---

### Task 6: Dashboard "How you use Claude Code" section (markup + styles + render + wiring)

**Why:** The user-facing surface. A dedicated **Insights** tab/panel holds the three sub-charts (task-mix-over-time stacked bars, when-you-work rhythm, time-spent trend) behind a **local 1/3/6/12-month lookback selector** (independent of the global period seg, which only offers today/7d/30d/month/all). Auto-refresh uses the **shape-signature + surgical-height** pattern (landmine #22): the bar skeleton is rebuilt via `innerHTML` ONLY when the bucket/hour SET changes; otherwise only `style.height` leaves are written, so nothing with a running animation is destroyed. A light install shows a friendly empty state, never scary negatives (review #09).

> **Coexistence NOTE (read before editing markup):** Phases 1–2 introduce the **Code Insights** area (a `data-tab="insights"` + `<section data-panel="insights">`). If that tab/panel ALREADY exists on `main`, **do not add a second one** — place the reflection `<div class="card reflect-card">…</div>` group INSIDE the existing `data-panel="insights"` section and skip adding the tab button. If it does NOT yet exist (Phase 3 landing first), add both as written below. Verify with `grep -n 'data-panel="insights"\|data-tab="insights"' public/index.html` before writing.

**Files**
- Modify: `/Users/adnanrashid/Projects/clauge/public/index.html` — add the Insights tab button (if absent) + the reflection card group.
- Modify: `/Users/adnanrashid/Projects/clauge/public/styles.css` — add `.reflect-*` styles.
- Modify: `/Users/adnanrashid/Projects/clauge/public/app.js` — `state.data.reflection` slot; `refreshReflection()`; `renderReflection()` (surgical); local lookback seg wiring; hooks in `switchTab` + `refreshAll` + boot.

**Steps**

- [ ] **Step 1: Add the tab button (if absent) + the reflection section markup to `public/index.html`.**

  a. **Tab button** — in the `<nav class="tabs …" id="tabs">` block, add after the `models` button (line 53), BEFORE `settings` (skip if an `insights` tab already exists):

  ```html
      <button data-tab="insights">Insights</button>
  ```

  b. **Section** — add a new panel (or, per the coexistence note, its inner card group) after the `models` panel's closing `</section>` (find it after the models tables; append before the `settings` panel). Full block:

  ```html
  <section data-panel="insights" hidden>
    <div class="card reflect-card">
      <div class="card-head">
        <div class="card-title-row">
          <h3 class="card-title">How you use Claude Code</h3>
          <span class="card-sub">heuristic · computed locally · no AI</span>
        </div>
        <div class="seg glass-pill" id="reflect-seg" role="tablist" aria-label="Lookback">
          <span class="indicator" id="reflect-ind"></span>
          <button data-lookback="1mo" role="tab">1M</button>
          <button data-lookback="3mo" role="tab" aria-selected="true">3M</button>
          <button data-lookback="6mo" role="tab">6M</button>
          <button data-lookback="12mo" role="tab">12M</button>
        </div>
      </div>

      <div id="reflect-empty" class="empty" hidden>
        Start using Claude Code and your task mix, working rhythm and time spent will appear here.
      </div>

      <div id="reflect-body">
        <div class="reflect-block">
          <div class="reflect-block-head">
            <h4 class="reflect-h">Task mix over time</h4>
            <span class="card-sub" id="reflect-taskmix-meta">—</span>
          </div>
          <div class="reflect-stack" id="reflect-taskmix" aria-label="Task mix over time"></div>
          <div class="reflect-legend" id="reflect-legend"></div>
        </div>

        <div class="reflect-block">
          <div class="reflect-block-head">
            <h4 class="reflect-h">When you work</h4>
            <span class="card-sub" id="reflect-rhythm-meta">local time</span>
          </div>
          <div class="bar-chart reflect-rhythm" id="reflect-rhythm"></div>
        </div>

        <div class="reflect-block">
          <div class="reflect-block-head">
            <h4 class="reflect-h">Time spent</h4>
            <span class="card-sub" id="reflect-trend-meta">—</span>
          </div>
          <div class="bar-chart reflect-trend" id="reflect-trend"></div>
        </div>
      </div>
    </div>
  </section>
  ```

- [ ] **Step 2: Add styles to `public/styles.css`.** Append (reusing existing tokens + the `--act-1..8` category palette already used by `renderActivityTable`):

  ```css
  /* ── Reflection section (Code Insights Phase 3) ───────────────────── */
  .reflect-block { margin-top: 20px; }
  .reflect-block:first-child { margin-top: 8px; }
  .reflect-block-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
  .reflect-h { font-size: 13px; font-weight: 600; margin: 0; }

  /* Task-mix-over-time: one stacked column per bucket. */
  .reflect-stack { display: flex; align-items: flex-end; gap: 4px; height: 140px; }
  .reflect-stack .stack-col { flex: 1 1 0; display: flex; flex-direction: column-reverse; height: 100%; border-radius: 4px; overflow: hidden; min-width: 3px; }
  .reflect-stack .stack-seg { width: 100%; transition: height var(--dur-fast, 150ms) ease; }
  .reflect-legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
  .reflect-legend .lg { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-2); }
  .reflect-legend .lg .sw { width: 10px; height: 10px; border-radius: 3px; }

  /* Rhythm + trend reuse the .bar-chart shell; scale their own heights. */
  .reflect-rhythm, .reflect-trend { height: 120px; }
  .reflect-trend .bar { background: var(--accent, #6aa9ff); }
  ```

  > If your `styles.css` uses different token names for durations/accent, match the ones the existing `.bar-chart`/`.bar` rules use (grep `--act-1`, `.bar-chart`, `.indicator` to confirm the local names). The `--act-N` category vars are already defined (used by By-activity).

- [ ] **Step 3: Wire `public/app.js`.** Four edits:

  a. **State slot** — add `reflection: null,` to the `state.data` object (after `heatmap: null,`, line 29):

  ```js
      heatmap: null,
      reflection: null,
  ```

  b. **Render + refresh functions** — add near the other render functions (e.g. after `renderPeakHours`, line 789). Uses the pure `reflectionView` + the shape-signature/surgical pattern:

  ```js
  // ═══════════════════════════════════════════════════════════
  //  Reflection — "How you use Claude Code" (Code Insights Phase 3)
  // ═══════════════════════════════════════════════════════════
  // The reflection section has its OWN 1/3/6/12-month lookback (independent of
  // the global period seg). It fetches /api/reflection?period=<lookback> and
  // renders three sub-charts. Auto-refresh uses shape-signature + surgical
  // height writes (landmine #22): the bar skeleton is rebuilt only when the
  // bucket/hour SET changes; otherwise only style.height leaves are written.
  const REFLECT_CAT_COLORS = {
    Testing: 'var(--act-1)', Build: 'var(--act-2)', GitOps: 'var(--act-3)', Coding: 'var(--act-4)',
    Debugging: 'var(--act-5)', Exploration: 'var(--act-6)', Planning: 'var(--act-7)', Conversation: 'var(--act-8)',
  };
  let __reflectTaskShape = null;
  let __reflectRhythmShape = null;
  let __reflectTrendShape = null;

  function reflectLookback() {
    return document.querySelector('#reflect-seg button[aria-selected="true"]')?.dataset.lookback ?? '3mo';
  }

  function fmtDurationShort(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0m';
    const mins = Math.round(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  async function refreshReflection() {
    const panel = document.querySelector('[data-panel="insights"]');
    if (!panel) return; // section not present (Phase 1-2 area absent) — no-op
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    try {
      state.data.reflection = await api('/api/reflection', { period: reflectLookback(), tz });
      renderReflection();
    } catch (err) {
      console.error('refreshReflection failed', err);
    }
  }

  function renderReflection() {
    const body = document.getElementById('reflect-body');
    const emptyEl = document.getElementById('reflect-empty');
    if (!body || !emptyEl) return;
    const view = window.ClaugeDashSwr?.reflectionView(state.data.reflection) ?? { isEmpty: true, buckets: [], rhythm: [], rhythmMax: 1, trend: [], trendMax: 1 };

    if (view.isEmpty) {
      body.hidden = true;
      emptyEl.hidden = false;
      __reflectTaskShape = __reflectRhythmShape = __reflectTrendShape = null;
      return;
    }
    emptyEl.hidden = true;
    body.hidden = false;

    renderReflectTaskMix(view);
    renderReflectRhythm(view);
    renderReflectTrend(view);
  }

  function renderReflectTaskMix(view) {
    const wrap = document.getElementById('reflect-taskmix');
    const meta = document.getElementById('reflect-taskmix-meta');
    const legend = document.getElementById('reflect-legend');
    if (!wrap) return;
    meta.textContent = `${view.buckets.length} bucket${view.buckets.length === 1 ? '' : 's'}`;

    const sig = view.buckets.map((b) => b.bucketStart).join('|');
    if (__reflectTaskShape !== sig) {
      // Structural change -> rebuild the column skeleton (each column keyed by bucketStart).
      wrap.innerHTML = view.buckets
        .map((b) => `<div class="stack-col" data-key="${escapeHtml(b.bucketStart)}" title="${escapeHtml(b.bucketStart)}"></div>`)
        .join('');
      // Legend = the union of categories present, in palette order.
      const present = [];
      for (const b of view.buckets) for (const s of b.segments) if (!present.includes(s.category)) present.push(s.category);
      legend.innerHTML = present
        .map((c) => `<span class="lg"><span class="sw" style="background:${REFLECT_CAT_COLORS[c] ?? 'var(--text-3)'}"></span>${escapeHtml(c)}</span>`)
        .join('');
      __reflectTaskShape = sig;
    }
    // Surgical: (re)write each column's segments. Segment counts can change per
    // tick, so segments are innerHTML'd per column, but these bars carry no
    // running keyframe animation (only a height transition), so no #22 restart.
    const cols = wrap.querySelectorAll('.stack-col');
    view.buckets.forEach((b, i) => {
      const col = cols[i];
      if (!col) return;
      col.innerHTML = b.segments
        .map((s) => `<div class="stack-seg" style="height:${(s.pct * 100).toFixed(2)}%;background:${REFLECT_CAT_COLORS[s.category] ?? 'var(--text-3)'}" title="${escapeHtml(s.category)}: ${s.turns}"></div>`)
        .join('');
    });
  }

  function renderReflectRhythm(view) {
    const wrap = document.getElementById('reflect-rhythm');
    if (!wrap) return;
    const hours = utcHoursToLocal(view.rhythm); // localizes + reorders to 0..23 local
    const sig = `${hours.length}`;
    if (__reflectRhythmShape !== sig) {
      wrap.innerHTML = hours.map((h) => `<div class="bar" data-hour="${h.hour}"></div>`).join('');
      __reflectRhythmShape = sig;
    }
    const bars = wrap.querySelectorAll('.bar');
    hours.forEach((h, i) => {
      const pct = (h.calls / view.rhythmMax) * 100;
      const bar = bars[i];
      if (!bar) return;
      bar.style.height = `${Math.max(2, pct).toFixed(1)}%`;
      bar.classList.toggle('hot', pct > 55);
      bar.title = `${String(h.hour).padStart(2, '0')}:00 — ${h.calls} calls`;
    });
  }

  function renderReflectTrend(view) {
    const wrap = document.getElementById('reflect-trend');
    const meta = document.getElementById('reflect-trend-meta');
    if (!wrap) return;
    const totalMs = view.trend.reduce((s, t) => s + t.durationMs, 0);
    meta.textContent = fmtDurationShort(totalMs);
    const sig = view.trend.map((t) => t.bucketStart).join('|');
    if (__reflectTrendShape !== sig) {
      wrap.innerHTML = view.trend.map((t) => `<div class="bar" data-key="${escapeHtml(t.bucketStart)}"></div>`).join('');
      __reflectTrendShape = sig;
    }
    const bars = wrap.querySelectorAll('.bar');
    view.trend.forEach((t, i) => {
      const pct = (t.durationMs / view.trendMax) * 100;
      const bar = bars[i];
      if (!bar) return;
      bar.style.height = `${Math.max(2, pct).toFixed(1)}%`;
      bar.title = `${t.bucketStart} — ${fmtDurationShort(t.durationMs)} · ${t.sessionCount} session${t.sessionCount === 1 ? '' : 's'}`;
    });
  }
  ```

  c. **Lookback seg + tab wiring** — in `bindSegments()` (near the `period-seg` wiring, line 1288), add the reflection seg handler; and in `switchTab` add the insights hook. Insert after the `period-seg` `forEach` block (before the `const tabs = …` line, ~line 1298):

  ```js
    const reflectSeg = document.getElementById('reflect-seg');
    if (reflectSeg) {
      reflectSeg.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          reflectSeg.querySelectorAll('button').forEach((b) => b.removeAttribute('aria-selected'));
          btn.setAttribute('aria-selected', 'true');
          moveIndicator(reflectSeg, 'reflect-ind');
          refreshReflection();
        });
      });
    }
  ```

  In `switchTab` (line 1301), add the insights hook next to the settings one:

  ```js
      if (name === 'settings') renderSettings();
      if (name === 'insights') { moveIndicator(document.getElementById('reflect-seg'), 'reflect-ind'); refreshReflection(); }
  ```

  d. **Auto-refresh hook** — in `refreshAll()`, add a best-effort call next to `refreshHeatmap()` (line 1451), so the reflection section stays current on the 60s tick (no-ops when the panel isn't rendered):

  ```js
      refreshHeatmap();
      refreshReflection();
  ```

- [ ] **Step 4: Manual/vm test the render seam (no browser yet).** The pure logic is covered by Task 5. For the DOM code, run the JS suite to confirm no syntax/import regressions: `npm test` → `# fail 0`. (There is no jsdom harness for `app.js` in this repo — the vm-testable logic is deliberately in `swr.js`; the DOM code is verified in the browser next.)

- [ ] **Step 5: Visual verify in a real browser (engineering-discipline rule #3 — REQUIRED for UI).** Serve + screenshot with the `/visual-verify` skill (or `visual-verify`):
  - Boot: `NO_OPEN=1 node server.js` (or the dev entry), open `http://localhost:3456`, click the **Insights** tab.
  - Confirm: task-mix stacked bars render with category colors + legend; the 1M/3M/6M/12M selector re-fetches and re-renders (the indicator slides); "When you work" shows the localized hour histogram; "Time spent" shows the per-bucket bars with an hh/mm total; on a light/empty install the friendly empty state shows instead.
  - Confirm surgical behavior: with DevTools, watch that a 60s auto-refresh on unchanged data does NOT rebuild the column skeleton (no `childList` mutation on `#reflect-taskmix` when the bucket set is unchanged) — only height leaves update. This is the landmine #22 guarantee.
  - Screenshot both themes if the dashboard supports theme toggle.

- [ ] **Step 6: Commit.**
  ```bash
  git add public/index.html public/styles.css public/app.js
  git commit -m "feat(dashboard): 'How you use Claude Code' reflection section (task-mix/rhythm/time-spent, 1/3/6/12mo)"
  ```

- [ ] **Step 7: Full gate.** `npm run check` — the WHOLE command (validators + cargo fmt + clippy + cargo test + npm test), exit 0. Never pipe it through `tail`/`grep` (masks the exit code — proof-of-done rule #1).

- [ ] **Step 8: Open PR 3**, `gh pr checks --watch`, review (UI verified in-browser per Step 5), squash-merge.

---

## Definition of done (all three PRs merged)

- `lib/period.js` accepts `1mo/3mo/6mo/12mo`; existing tokens unchanged. `lib/reflection.js` pure, no LLM/network imports, fixture-tested (day + week buckets, rhythm, duration, tz, guards).
- `GET /api/reflection` returns `{ period, taskMixOverTime, rhythm, durationTrend }`, 400s bad periods, reachable via the loopback CORS allowlist.
- Snapshot carries a compact `reflection` key; `schemaVersion` still `1`; no bare-null typed slots; payload tripwire still under ceiling.
- Dashboard "How you use Claude Code" section renders all three sub-charts behind a 1/3/6/12-month selector, with a friendly empty state and landmine-#22-safe auto-refresh, **verified in a real browser**.
- `npm run check` green on each PR before merge (proof-of-done: cite the command + exit 0 + counts).

## Landmines honored
- **#22** — surgical shape-signature updates in the reflection render; no `innerHTML=` on animated regions; bars carry transitions only, never keyframes.
- **#37** — snapshot `reflection` is additive/optional; `schemaVersion` stays 1.
- **Review #26** — no new null-in-a-typed-slot keys; reflection fields are always arrays/objects.
- **#14 / #38** — tests at `test/*.test.js`, ESM, `node --test`.
- **#29** — the merge gate is the full `npm run check`, not a validator subset.
- **#39** — no new served JS file; the reflection UI rides already-registered assets (if you DO add one, register both SEA manifests).
- **NO-LLM invariant** — reiterated at the top; never read prompt text or call a model to "improve" labels.

---

## Phase 4 — iOS surfacing (separate `clauge-ios` release)

> **Not built from this plan.** Phase 4 lives in the `clauge-ios` repo (`~/Projects/clauge-ios`), needs an Xcode build + App Store release, and gets its **own spec + plan** at build time. Scoped here so the desktop phases publish the right data.

**What it does:** the iOS Analytics tab reads the three new optional snapshot keys (`codeOutput`, `gitValue`, `reflection`) the Mac now publishes, and adds matching cards (Code Output, Value, "How you use Claude Code").

**Hard requirements when it's built:**
- **Bundle the review's P1 #26 fix** — the current iOS decoder (`AnalyticsSnapshot.decodeWire`) fails the *whole* snapshot on one null in a typed forecast slot. Phase 4 makes the new keys' fields optional/lenient (skip/repair a bad sample, never fail the whole payload) — this phase touches that exact contract, so it fixes it.
- **schemaVersion stays 1** — the desktop phases added the keys as additive optional; old iOS ignores them, new iOS reads them. No Mac-side bump (landmine #37 — a bump would need iOS-approved-first).
- **Money is DOLLARS** in the snapshot (iOS landmine #18) — render direct, never ÷100.
- iOS has **no CI** — manual `xcodebuild` + on-device eyeball on real paired data before submission.
- Follows `clauge-ios` conventions: xcodegen (`project.yml`), `ClaugeScreen` shell, `@StateObject` hosts (landmine #36), SWR VMs (landmine #22), custom tab glyphs (landmine #37).

**Verification:** on-device, with a real Mac publishing the new keys — the iPhone cards must match the desktop numbers; a snapshot with a null forecast sample must NOT blank the tab (the regression test for review #26).
