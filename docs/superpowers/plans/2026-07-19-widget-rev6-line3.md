# Clauge Widget Rev 6 — Scoped Gauges to Line 3, Money Retired, Yellow Hygiene Pair

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement widget spec rev 6 — Spend/ROI leave `clauge status`, the scoped (Fable) gauges move from line 2 to the front of line 3, and Context Used / Compactions recolor to yellow with red kept at ≥90% / 2+.

**Architecture:** One pure-renderer change. `lib/cli/status-render.js` is the whole surface: `buildLine2` drops its scoped-gauge loop (hero-only again), `buildLine3` gains that loop in leading position and loses the Spend/ROI blocks, and a two-tier `hygienePaint` (yellow / red) replaces the threshold ladder for the hygiene pair. The `/v1` API, the server, `--json`, and the cache pipeline are untouched — `/v1` keeps emitting `Spend` / `ROI (30d)` / `ROI` text lines (frozen surface, landmine #47); the widget just stops reading them.

**Tech Stack:** Node ESM, raw ANSI escape codes (no chalk — this file defines the codebase's ANSI convention), `node:test` runner.

**Spec:** `docs/superpowers/specs/2026-07-16-cli-statusline-widget-design.md` — rev 6 blockquote (top of file). Visual reference: the approved "Clauge Widget — Rev 6 Preview" artifact (claude.ai/code/artifact/dd8325e0-d62c-437e-a234-70b2d031fb0b).

## Global Constraints

- Branch: all work on `feat/widget-rev6-status-line3` (already exists; spec commit `af448b9` is on it). Never commit to `main`.
- `lib/cli/status-render.js` stays PURE — zero I/O, zero clock reads, every input injected.
- Every externally-sourced string (wire labels, stdin payload fields, branch) passes through the existing `sanitize()` before painting — do not remove any `sanitize()` call.
- Exit-0-always for the render path; segments OMIT on missing data, never crash.
- Output must still read with colors stripped — numbers carry the meaning, color is emphasis.
- Scoped gauges: cap `SCOPED_GAUGES_MAX = 2`, wire order, **blue always** (rev 5.1) — unchanged, only their line changes.
- Hero gauges (Session/Weekly) keep green <75 / orange ≥75 / red ≥90, orange as 256-color `38;5;208` with plain-yellow fallback — untouched.
- No version bump in this PR — release lockstep (4 files) is a separate mission per `docs/RELEASE_CHECKLIST.md`.
- Test files must live under `test/cli/` (the `npm test` glob is `test/*.test.js test/cli/*.test.js`; a third dir is silently skipped).
- Never pipe a gate command through `tail`/`head`/`grep` (masks exit code; a PreToolUse hook blocks it). Run gates bare or redirect to a file and check `$?`.
- After editing any file where escape-sequence text appears in comments/strings, byte-scan it: `python3 -c "import sys; d=open(sys.argv[1],'rb').read(); bad=[i for i,c in enumerate(d) if (c<0x20 and c not in (9,10,13)) or c==0x7f]; print('CLEAN' if not bad else f'RAW BYTES AT {bad[:10]}')" <file>` — the Write/Edit `\u`-escape decoding landmine.
- Commit messages: Conventional Commits, no attribution trailers.

---

### Task 1: Renderer rev 6 + full test-contract update (TDD)

**Files:**
- Modify: `lib/cli/status-render.js` (header comment ~lines 1–19, `SCOPED_LABEL_RE` comment ~35–38, `compactionPaint` ~105–109, `buildLine2` ~194–224, `buildLine3` ~226–261, call site ~298)
- Test: `test/cli/status-render.test.js` (golden ~101–122, thresholds ~186–207, omission ~216–261, scoped describe ~327–429)
- Test: `test/cli/status.test.js` (fixture ~60–70, live-rung assertion ~120–127)

**Interfaces:**
- Consumes: existing `buildGaugeSegment(label, line, paint, nowMs, colorize)` — unchanged; existing `sanitize`, `paint.*`, `SCOPED_GAUGES_MAX`, `SCOPED_LABEL_RE`.
- Produces: `buildLine3(snapshot, payload, compactions, paint, nowMs)` — note the NEW trailing `nowMs` param (scoped gauges need it for `(resets …)`); new module-private `hygienePaint(isCritical, paint)`; `compactionPaint` is DELETED. `renderStatus` signature unchanged — later tasks and all callers see no API change.

- [ ] **Step 1: Rewrite the failing tests in `test/cli/status-render.test.js`**

Apply each edit below. The default `snapshot()` fixture keeps its `Spend`/`ROI`/`ROI (30d)` text lines — they are wire truth and now prove the widget ignores them.

1a. Golden render (the `renders the §4 golden output exactly` test) — line 3 loses money:

```js
  test('renders the §4 golden output exactly (rev 6: line 3 = hygiene, no money)', () => {
    assert.equal(
      render(),
      [
        'Opus 4.8 · ~/Projects/clauge · +267/-0 · ⧗ 42m · main',
        'Session ▓▓░░░░░░░░ 20% (resets 2h) · Weekly ▓░░░░░░░░░ 9% (resets 5d)',
        'Context Used 46% · Compactions 0',
      ].join('\n'),
    );
  });
```

1b. DELETE both ROI tests (`ROI segment prefers the ROI (30d) line…` and `ROI segment falls back…`) and add in their place:

```js
  test('Spend and ROI wire lines are ignored — money left the widget (rev 6)', () => {
    const out = render();
    assert.ok(!out.includes('$664'), 'Spend line must not render');
    assert.ok(!out.includes('ROI'), 'ROI lines must not render');
  });
```

1c. Replace the `Context Used obeys the same 75/90 scale` test:

```js
  test('Context Used is yellow below 90 and red at 90+ — no orange tier (rev 6)', () => {
    const at = (pct) => {
      const p = payload();
      p.context_window.used_percentage = pct;
      return render({ payload: p }, { ansi: true, orange256: true });
    };
    assert.ok(at(46).includes(`${YELLOW}46%`), 'calm value is yellow');
    assert.ok(at(78).includes(`${YELLOW}78%`), '78% stays yellow — orange is hero-only now');
    assert.ok(!at(78).includes(ORANGE), 'no orange anywhere at 78% context');
    assert.ok(at(95).includes(`${RED}95%`), 'red emergency tier survives');
  });
```

1d. Replace the `Compactions has its own scale` test:

```js
  test('Compactions is yellow at 0–1 and red at 2+ (rev 6)', () => {
    const at = (n) => render({ compactions: n }, { ansi: true, orange256: true });
    assert.ok(at(0).includes(`${YELLOW}0`));
    assert.ok(at(1).includes(`${YELLOW}1`));
    assert.ok(!at(1).includes(ORANGE), 'the orange 1-compaction tier is retired');
    assert.ok(at(2).includes(`${RED}2`));
    assert.ok(at(5).includes(`${RED}5`));
  });
```

1e. Replace the `yellow is reserved for money` test:

```js
  test('yellow is the hygiene base — line 3 has yellow values and zero orange (rev 6)', () => {
    const out = render({}, { ansi: true, orange256: true });
    const line3 = out.split('\n')[2];
    assert.ok(line3.includes(`${YELLOW}46%`), 'Context Used value is yellow');
    assert.ok(line3.includes(`${YELLOW}0`), 'Compactions value is yellow');
    assert.ok(!line3.includes(ORANGE), 'orange never appears on line 3');
  });
```

1f. Replace the `null payload drops line 1…` test (with no payload, no compactions, and no scoped lines, line 3 is now empty and omitted entirely) and add a scoped-line companion:

```js
  test('null payload drops line 1 and the whole line 3 when nothing scoped exists', () => {
    const out = render({ payload: null, branch: null, compactions: null });
    const lines = out.split('\n');
    assert.equal(lines.length, 1, 'only the hero gauge line remains');
    assert.match(lines[0], /^Session /);
  });

  test('null payload with a scoped line still renders the scoped gauge as the last line', () => {
    const snap = snapshot();
    snap.lines.push({ type: 'progress', label: 'Weekly (Fable)', used: 68, resets_at: null });
    const out = render({ payload: null, branch: null, compactions: null, snapshot: snap });
    const lines = out.split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[1], 'Fable ▓▓▓▓▓▓▓░░░ 68%');
  });
```

1g. Replace the `snapshot without Session/Weekly still renders spend + ROI` test:

```js
  test('snapshot without progress lines still renders the hygiene pair on its own line', () => {
    const snap = snapshot();
    snap.lines = snap.lines.filter((l) => l.type !== 'progress');
    const out = render({ snapshot: snap });
    assert.ok(!out.includes('Session'));
    assert.equal(out.split('\n')[1], 'Context Used 46% · Compactions 0');
  });
```

1h. In the `terminal-escape injection` describe, update ONLY the comment of the `a poisoned cache Spend/ROI value cannot set the terminal title` test (behavior unchanged — it now guards against reintroduction):

```js
  // Rev 6: the widget no longer reads any text lines, so this is a
  // reintroduction guard — if Spend/ROI rendering ever comes back, hostile
  // cache values must still never reach the host terminal.
```

1i. Rework the scoped describe. Rename to `scoped-limit gauges — rev 5 shape, rev 6 placement (line 3)` and update each test:

```js
  test('a scoped progress line leads line 3, before the hygiene pair', () => {
    const snap = snapshot();
    snap.lines.splice(2, 0, {
      type: 'progress',
      label: 'Weekly (Fable)',
      used: 68,
      limit: 100,
      format: { kind: 'percent' },
      resets_at: new Date(NOW + 4 * 24 * 3600_000).toISOString(),
    });
    const line3 = render({ snapshot: snap }).split('\n')[2];
    assert.equal(line3, 'Fable ▓▓▓▓▓▓▓░░░ 68% (resets 4d) · Context Used 46% · Compactions 0');
  });

  test('no scoped lines leaves line 2 hero-only and line 3 hygiene-only (regression pin)', () => {
    const lines = render().split('\n');
    assert.equal(lines[1], 'Session ▓▓░░░░░░░░ 20% (resets 2h) · Weekly ▓░░░░░░░░░ 9% (resets 5d)');
    assert.equal(lines[2], 'Context Used 46% · Compactions 0');
  });

  test('caps scoped gauges at 2, wire order wins', () => {
    const snap = snapshot();
    snap.lines.splice(
      2,
      0,
      { type: 'progress', label: 'Weekly (Fable)', used: 10, resets_at: null },
      { type: 'progress', label: 'Session (Sonnet)', used: 20, resets_at: null },
      { type: 'progress', label: 'Weekly (Opus)', used: 30, resets_at: null },
    );
    const line3 = render({ snapshot: snap }).split('\n')[2];
    assert.ok(line3.includes('Fable'), 'first scoped line renders');
    assert.ok(line3.includes('Sonnet'), 'second scoped line renders');
    assert.ok(!line3.includes('Opus'), 'third scoped line is dropped by the cap');
  });

  test('a hostile scoped label cannot smuggle an ANSI escape into line 3', () => {
    const snap = snapshot();
    snap.lines.push({
      type: 'progress',
      label: 'Weekly (Fa\x1b[31mble)',
      used: 50,
      resets_at: null,
    });
    const out = render({ snapshot: snap }, { ansi: true, orange256: true });
    assert.ok(!out.includes('\x1b[31mble'), 'no raw ESC byte survives in the rendered line');
    assert.match(out.split('\n')[2], /Fa\[31mble/);
  });

  test('a Session (X) shaped label renders a gauge labeled X — prefix does not matter', () => {
    const snap = snapshot();
    snap.lines.push({ type: 'progress', label: 'Session (Haiku)', used: 15, resets_at: null });
    const line3 = render({ snapshot: snap }).split('\n')[2];
    assert.match(line3, /Haiku ▓▓░░░░░░░░ 15%/);
  });

  test('a scoped line without resets_at omits the resets suffix on that gauge', () => {
    const snap = snapshot();
    snap.lines.push({ type: 'progress', label: 'Weekly (Fable)', used: 40 });
    const line3 = render({ snapshot: snap }).split('\n')[2];
    assert.ok(line3.startsWith('Fable ▓▓▓▓░░░░░░ 40% ·'), 'no (resets …) suffix before the separator');
  });

  test('scoped gauges render blue always (owner decision), never the warning thresholds', () => {
    // Rev 5.1: scoped gauges ignore the 75/90 ladder entirely — blue at 80%
    // (hero-orange territory) AND at 95% (hero-red territory). Assert against
    // line 3 only; with default fixture values (context 46, compactions 0)
    // the hygiene pair is yellow, so "no red" holds for the whole line.
    const snap80 = snapshot();
    snap80.lines.push({ type: 'progress', label: 'Weekly (Fable)', used: 80, resets_at: null });
    const line3At80 = render({ snapshot: snap80 }, { ansi: true, orange256: true }).split('\n')[2];
    assert.ok(line3At80.includes(`${BLUE}▓▓▓▓▓▓▓▓░░`), 'scoped bar at 80% is blue');
    assert.ok(line3At80.includes(`${BLUE}80%`), 'scoped pct at 80% is blue');
    assert.ok(!line3At80.includes(ORANGE), 'scoped gauge never emits orange');
    assert.ok(!line3At80.includes(RED), 'scoped gauge never emits red');

    const snap95 = snapshot();
    snap95.lines.push({ type: 'progress', label: 'Weekly (Fable)', used: 95, resets_at: null });
    const line3At95 = render({ snapshot: snap95 }, { ansi: true, orange256: true }).split('\n')[2];
    assert.ok(line3At95.includes(`${BLUE}▓▓▓▓▓▓▓▓▓▓`), 'scoped bar at 95% is blue');
    assert.ok(line3At95.includes(`${BLUE}95%`), 'scoped pct at 95% is blue');
    assert.ok(!line3At95.includes(ORANGE), 'scoped gauge never emits orange');
    assert.ok(!line3At95.includes(RED), 'scoped gauge never emits red');
  });

  test('a text-type line shaped like a scoped label is not rendered as a gauge', () => {
    const snap = snapshot();
    snap.lines.push({ type: 'text', label: 'Weekly (Fake)', value: 'nope' });
    assert.ok(!render({ snapshot: snap }).includes('Fake'));
  });
```

1j. In `test/cli/status.test.js`: add one scoped progress line to the shared fixture, immediately after the `Weekly` progress entry (before the `Spend` text line):

```js
    {
      type: 'progress',
      label: 'Weekly (Fable)',
      used: 68,
      limit: 100,
      format: { kind: 'percent' },
      resets_at: new Date(NOW + 4 * 24 * 3600_000).toISOString(),
    },
```

…and update the live-rung assertions in `sidecar live: renders quota + money lines and exits 0` (rename it too):

```js
  test('sidecar live: renders quota + scoped + hygiene lines and exits 0', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const { code, stdout } = await capture(() => mod.run(parsed(), baseDeps()));
    assert.equal(code, 0);
    assert.match(stdout, /Session .*20%/);
    assert.match(stdout, /Fable ▓▓▓▓▓▓▓░░░ 68%/);
    assert.ok(!stdout.includes('$664'), 'money left the widget in rev 6');
    assert.ok(!stdout.includes('ROI'), 'ROI left the widget in rev 6');
  });
```

If any OTHER test in `status.test.js` fails after the fixture gains the Fable line, fix that test's expectation (the fixture change only adds a line-3 leading segment) — do not remove the fixture line.

- [ ] **Step 2: Run the render tests to verify they fail**

Run: `node --test test/cli/status-render.test.js`
Expected: FAIL — the golden test, threshold tests, omission tests, and every reworked scoped test fail against the current rev-5 renderer (money still present, scoped gauges still on line 2, hygiene pair still green/orange). The injection and max-width describes still pass.

- [ ] **Step 3: Implement rev 6 in `lib/cli/status-render.js`**

3a. Replace the header color-grammar comment (lines 6–16, keep lines 1–5 and 18–19 as-is):

```js
// Color grammar (owner-locked 2026-07-18; rev 6 recolor 2026-07-19):
//   magenta  model + git branch          yellow  hygiene base — Context Used
//   blue     working path, scoped gauges         <90% and Compactions 0–1
//   green/red lines added/removed        orange  hero-gauge warning ≥75% ONLY
//   cyan     session runtime             red     hero/Context ≥90%, compactions 2+
//   dim      separators, labels' context
// Hero gauges (Session / Weekly) color INDEPENDENTLY: green <75, orange ≥75,
// red ≥90. Scoped gauges are blue ALWAYS (rev 5.1). Money (Spend/ROI) left
// the widget in rev 6 — /v1 still serves those lines; the widget no longer
// reads them. Orange is 256-color (\x1b[38;5;208m) with plain yellow as the
// 8/16-color fallback — never collapse orange into the hygiene yellow on
// capable terminals. Everything must still read with colors stripped: the
// numbers carry the meaning, color is emphasis.
```

3b. Update the `SCOPED_GAUGES_MAX` comment block (lines 35–38):

```js
// Rev 5 (2026-07-19, owner request): scoped-limit gauges. /v1 progress lines
// shaped `Weekly (<label>)` / `Session (<label>)` (e.g. `Weekly (Fable)`)
// render as gauges, wire order, capped at 2 for line-width protection.
// Rev 6 moved them from line 2 to the leading position of line 3.
```

3c. Replace `compactionPaint` (lines 105–109) with the two-tier hygiene painter:

```js
// Rev 6: the hygiene pair (Context Used, Compactions) renders yellow as its
// base and keeps only the red emergency tier — ≥90% context / 2+ compactions.
// The orange middle tier is hero-gauge-only now.
function hygienePaint(isCritical, paint) {
  return isCritical ? paint.red : paint.yellow;
}
```

3d. Replace `buildLine2` (and its leading comment) — hero-only:

```js
// ── Line 2: hero quota gauges — Session and Weekly progress lines from the
//    /v1 snapshot, each colored independently on its own value. Rev 6
//    (2026-07-19, owner request): hero-only again — the rev-5 scoped gauges
//    moved to line 3.
function buildLine2(snapshot, paint, nowMs) {
  const segments = [];
  for (const label of ['Session', 'Weekly']) {
    const line = snapshot.lines?.find((l) => l?.type === 'progress' && l?.label === label);
    if (!line) continue;
    const segment = buildGaugeSegment(label, line, paint, nowMs);
    if (segment) segments.push(segment);
  }
  return segments;
}
```

3e. Replace `buildLine3` (and its leading comment) — scoped gauges lead, money gone, hygiene yellow. Note the new `nowMs` parameter:

```js
// ── Line 3: scoped gauges + hygiene. Rev 6 (2026-07-19, owner request):
//    the money pair (Spend / ROI) left the widget — /v1 still serves those
//    text lines (frozen surface, landmine #47); this renderer no longer
//    reads them. Scoped-limit gauges (rev 5 shape: wire order, cap
//    SCOPED_GAUGES_MAX, blue always per rev 5.1) lead the line, followed by
//    Context Used and Compactions — yellow base, red at ≥90% / 2+.
function buildLine3(snapshot, payload, compactions, paint, nowMs) {
  const segments = [];

  let scopedCount = 0;
  for (const line of snapshot.lines ?? []) {
    if (scopedCount >= SCOPED_GAUGES_MAX) break;
    if (line?.type !== 'progress' || typeof line.label !== 'string') continue;
    const match = SCOPED_LABEL_RE.exec(line.label);
    if (!match) continue;
    // Wire data — same defense-in-depth as the git-branch/model segments.
    const segment = buildGaugeSegment(sanitize(match[1]), line, paint, nowMs, paint.blue);
    if (!segment) continue;
    segments.push(segment);
    scopedCount += 1;
  }

  const ctx = payload?.context_window?.used_percentage;
  if (Number.isFinite(ctx)) {
    segments.push(`Context Used ${hygienePaint(ctx >= 90, paint)(`${ctx}%`)}`);
  }

  if (Number.isFinite(compactions)) {
    segments.push(`Compactions ${hygienePaint(compactions >= 2, paint)(String(compactions))}`);
  }
  return segments;
}
```

3f. Update the single call site in `renderStatus`:

```js
  const line3 = buildLine3(snapshot, payload, compactions, paint, nowMs);
```

Deleted along the way (verify none is still referenced anywhere in `lib/` — `grep -rn "compactionPaint\|textLine" lib/` should return nothing): `compactionPaint`, the `textLine` helper, and the Spend/ROI parsing blocks.

- [ ] **Step 4: Byte-scan the edited files (escape-decoding landmine)**

Run for each of the three edited files:
`python3 -c "import sys; d=open(sys.argv[1],'rb').read(); bad=[i for i,c in enumerate(d) if (c<0x20 and c not in (9,10,13)) or c==0x7f]; print(('CLEAN ' if not bad else 'RAW BYTES ') + sys.argv[1], bad[:10])" lib/cli/status-render.js`
(then the same for `test/cli/status-render.test.js` and `test/cli/status.test.js`)
Expected: `CLEAN` ×3. Note: the test files legitimately contain `\x1b` as SOURCE TEXT (backslash-x-1-b, 4 chars) — that is fine; the scan catches RAW control bytes only.

- [ ] **Step 5: Run the CLI test files to verify green**

Run: `node --test test/cli/status-render.test.js test/cli/status.test.js`
Expected: PASS, 0 failures. If a `status.test.js` test unrelated to Step 1j fails, fix its expectation per the Step 1j note.

- [ ] **Step 6: Run the full JS suite**

Run: `npm test`
Expected: exit 0, all tests pass (baseline was 593; count shifts slightly with the deleted/added tests — what matters is 0 failures).

- [ ] **Step 7: Commit**

```bash
git add lib/cli/status-render.js test/cli/status-render.test.js test/cli/status.test.js
git commit -m "feat(widget): rev 6 — scoped gauges lead line 3, spend/ROI retired, yellow hygiene pair"
```

---

### Task 2: README widget section

**Files:**
- Modify: `README.md:91-99` (sample render block + line descriptions)

**Interfaces:**
- Consumes: the rev-6 render shape from Task 1 (docs must match the shipped bytes).
- Produces: nothing downstream.

- [ ] **Step 1: Update the sample render block (lines 91–95)**

```text
Opus 4.8 · ~/Projects/clauge · +267/-0 · ⧗ 42m · main
Session ▓▓░░░░░░░░ 20% (resets 2h) · Weekly ▓░░░░░░░░░ 9% (resets 5d)
Fable ▓▓▓▓▓▓▓░░░ 68% (resets 4d) · Context Used 46% · Compactions 0
```

- [ ] **Step 2: Update the line-2 and line-3 descriptions (lines 98–99)**

```markdown
- **Line 2 — your quota.** Session and Weekly gauges color independently (green < 75%, orange ≥ 75%, red ≥ 90%).
- **Line 3 — model buckets and hygiene.** Model-scoped buckets — like claude.ai's current **"Fable"** weekly limit — get their own gauge, named live from the wire and rendered in **blue** so they read apart from the warning colors; when Anthropic renames or adds a bucket, the widget follows automatically. Then Context Used and a compaction counter, in yellow — red when context hits 90% or compactions hit 2. (Spend and ROI live in the popover, dashboard, and `/v1` API.)
```

- [ ] **Step 3: Verify no stale widget-money references remain**

Run: `grep -n "this window · ROI" README.md; echo "exit=$?"`
Expected: no matches, `exit=1`. (Other README mentions of ROI — popover/dashboard/`/v1` sections — are correct and stay.)

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): widget rev 6 — line 3 shows scoped buckets + yellow hygiene, money moved off the widget"
```

---

### Task 3: Full gate + live surface verification

**Files:** none created — verification only.

**Interfaces:**
- Consumes: the rev-6 renderer from Task 1 via the real `status` verb against the LIVE sidecar (port from `~/.clauge/active-port` via the port-file, never hardcoded).
- Produces: evidence lines for the PR body (exact commands + exit codes).

- [ ] **Step 1: Full CI gate, unpiped**

Run: `npm run check`
Expected: exit 0 (JS suite + cargo). Then run: `npm run test:sea`
Expected: exit 0, 3/3. If the SEA smoke asserts money content, update it to the rev-6 shape (same edit philosophy as Task 1 Step 1j) — but as of `20e288c` it is shape/exit-code based and should pass untouched.

- [ ] **Step 2: Live render — the widget is a UI; a unit suite is not a surface**

With the Clauge app running (sidecar on its live port), run:

```bash
printf '{"model":{"display_name":"Fable 5"},"workspace":{"current_dir":"/tmp"},"context_window":{"used_percentage":46}}' \
  | node server.js status > /tmp/rev6-live.out; echo "exit=$?"
```

Expected: `exit=0`. Then byte-verify (python, not grep — ugrep chokes on bracket escapes):

```bash
python3 - <<'EOF'
d = open('/tmp/rev6-live.out','rb').read()
esc = bytes([27])
lines = d.split(b'\n')
assert b'$' not in d and b'ROI' not in d, 'money must be gone'
fable_line = [l for l in lines if b'Fable ' in l and esc + b'[34m' in l]
assert fable_line, 'scoped gauge must render blue'
assert b'Context Used' in fable_line[0], 'scoped gauge and hygiene share line 3'
assert esc + b'[33m46%' in d, 'Context Used 46% must be yellow'
print('LIVE RENDER VERIFIED')
EOF
```

Expected: `LIVE RENDER VERIFIED`. (Search lines by content, never by position — with sparse stdin the widget omits segments and lines shift.) If the app is not running, start it or fall back to the isolated-server harness from the fable session; do not skip this step.

- [ ] **Step 3: Report evidence**

State in the task report: `npm run check` exit code, `test:sea` exit code, the live-verify output line, and the commit SHAs. No claim without its command.

---

## Self-Review (performed at write time)

- **Spec coverage:** rev 6 (a) money removal → Task 1 Steps 1a/1b/3e; (b) scoped move with rev-5 properties intact → 1f/1i/3e (cap, wire order, sanitize, blue-always all carried verbatim); (c) yellow-base/red-kept hygiene → 1c/1d/1e/3c; (d) unchanged invariants → regression pins in 1i (hero golden) and the untouched hero-threshold tests; README → Task 2; real-surface proof → Task 3.
- **Placeholder scan:** none — every step carries exact code or an exact command with expected output.
- **Type consistency:** `buildLine3(snapshot, payload, compactions, paint, nowMs)` defined in 3e matches the 3f call site; `hygienePaint(isCritical, paint)` defined in 3c matches both 3e uses; deleted `compactionPaint`/`textLine` are grepped for in Step 3 of Task 1.
