# Agent Learning Rulebook — Clauge

A running log of lessons learned the hard way while shipping Clauge.

Different from `AGENTS.md` — that file documents **stable conventions and landmines** (the codebase is structured this way; don't break it). This file documents **incidents and lessons** (this is what went wrong, and here's how to prevent recurrence).

**Author:** AI agents under Adnan's direction. Appended on every incident; entries are point-in-time observations that may go stale but the lesson stays.

## How to add an entry

When something ships broken, when a methodology gap is exposed, or when a smoke test catches a real bug:

1. Write the entry below using the template.
2. If the lesson generalizes across Adnan's other projects, also append to the global rulebook at `~/.claude/AGENT_LEARNINGS.md`.
3. Save to AI auto-memory at `~/.claude/projects/-Users-adnanrashid-Projects-clauge/memory/` so future Claude sessions inherit.
4. If the lesson is a stable codebase rule, distill into a numbered `AGENTS.md` landmine.

## Entry template

```markdown
## YYYY-MM-DD — vX.Y.Z | Short title

**Trigger:** what surfaced the issue.

**What went wrong:** root cause in plain English; cite file:line if useful.

**Lesson:** the generalizable rule in one sentence.

**Prevention:** concrete steps (validator, smoke checklist, CI gate).

**Hotfix:** what shipped to resolve.

**Cross-references:** AGENTS.md landmine, auto-memory key, global rulebook entry.
```

---

## Entries (most recent first)

## 2026-05-26 — v0.9.7 → v0.9.8 hotfix | Dashboard activity heatmap never rendered

**Trigger:** Adnan opened the dashboard on a fresh v0.9.7 install. The Activity card showed its header ("ACTIVITY — Last 365 days") and its footer ("clauge v0.9.7 · health · config"), but the heatmap grid area was completely blank. The `heatmap-stats` span still read the default `—` placeholder, never updating to the active-days/streak summary. Activity API was healthy — `curl http://127.0.0.1:3456/api/activity?period=365d` returned 365 days with 30 active days, 3-day current streak, longest 18-day. So the data path worked; the render path didn't.

**What went wrong:** Same class as v0.9.5 → v0.9.6, different facade.

The v0.9.5 B.1 string-migration commit moved 5 inline tooltip strings in `popover/heatmap.js` to the shared `popover/copy.json` registry via `t('heatmap.tooltipNoActivity', …)` etc. `popover/heatmap.js` is loaded by BOTH `popover/index.html` (menu-bar popover) and `public/index.html` (dashboard) — they share the renderer via `<script src="/popover/heatmap.js">`. The popover's HTML already loaded `lib/copy.js` (defines `window.t`); the dashboard's HTML didn't.

Result: in the dashboard, `window.t` was undefined. `ClaugeHeatmap.render()` ran, called `defaultTooltip(cell)` on the first non-empty cell, hit `t('heatmap.tooltipSessions', …)`, threw `ReferenceError: t is not defined`. The error aborted render BEFORE `rootEl.appendChild(table)` (line 204 of `popover/heatmap.js`). `replaceChildren()` had already wiped the root at line 132, so the heatmap area stayed empty. `renderActivityHeatmap`'s downstream stats update never ran either, so `heatmap-stats` kept its default placeholder.

Secondary issue: `popover/lib/copy.js` fetched the registry via the relative URL `'copy.json'`, which resolves to the loading page's directory. Fine from `/popover/index.html` (→ `/popover/copy.json`); broken from `/index.html` (→ `/copy.json`, 404). The fix had to address both.

Why v0.9.5 → v0.9.6 → v0.9.7 smoke didn't catch it: the heatmap path only errors when `defaultTooltip` runs, which requires at least one non-empty cell. The dev-mode test environment we used had fresh data on the popover (which works) but the dashboard smoke checks didn't iterate the heatmap render path with real data. Production users with any historical activity hit it immediately.

**Lesson:** When migrating JS to depend on a global facade (`window.ClaugeBridge`, `window.t`, future facades), **every HTML page that loads the migrated JS must independently load the facade definer FIRST**. Shared JS files used by multiple HTML pages multiply the surface area — each loader is an independent contract. This is the same lesson as v0.9.5 → v0.9.6, restated because it bit twice in 24 hours with a different facade.

Secondary lesson: scripts that fetch assets relative to the loading page break when the script is shared across pages at different paths. **Use absolute paths for shared-asset fetches** (`'/popover/copy.json'`, not `'copy.json'`).

**Prevention:**
- `scripts/validate-html-facade-loads.cjs` (v0.9.7) was ClaugeBridge-only. **Extended in v0.9.8** to also enforce the `t()`/`lib/copy.js` facade. New `FACADES` array at the top of the script — adding a future facade (e.g., a new `window.foo` global) is a one-entry addition.
- AGENTS.md landmine #20 expanded to a two-row facade table.
- Two new test cases in `test/validators.test.js` (11 tests total now) covering the t()/copy.js failure modes (HTML missing definer, definer loaded after caller).
- Open methodology gap (not fixed by this hotfix): the dashboard smoke testing in our release workflow doesn't render the heatmap with real production data. The v0.9.5 popover heatmap was iterated extensively; the dashboard heatmap got "looks fine" eyeballing. Future heatmap changes should include a Playwright smoke test against a fixture sidecar with non-zero activity counts (mirror what we did to verify this hotfix).

**Hotfix:** v0.9.8 — two source changes:
1. `public/index.html` — add `<script src="/popover/lib/copy.js" defer></script>` between the tauri-bridge tag and the heatmap tag.
2. `popover/lib/copy.js` — change `fetch('copy.json', …)` to `fetch('/popover/copy.json', …)` so it works from any page on the sidecar.

Verified end-to-end with Playwright against a freshly-spawned sidecar on a non-conflicting port: dashboard `#heatmap-root` rendered a `<table>` with 365 cells; `#heatmap-stats` text changed from `—` to `"30 active days · 3-day streak · longest 18"`; popover heatmap still rendered identically (tooltip "Sun Jun 1 — No activity" resolved from the registry, proving the absolute-path fetch worked from `/popover/index.html` too).

**Cross-references:**
- Auto-memory: [feedback_html_js_dep_loading](~/.claude/projects/-Users-adnanrashid-Projects-clauge/memory/feedback_html_js_dep_loading.md) — updated to add the t()/copy.js case alongside the original ClaugeBridge case.
- Global rulebook: `~/.claude/AGENT_LEARNINGS.md` — same lesson promoted as "facade migration: count loaders, not files."
- AGENTS.md landmine #20 — expanded to a two-facade table.
- Validator: `scripts/validate-html-facade-loads.cjs` — refactored to a `FACADES` array.

## 2026-05-26 — v0.9.5 → v0.9.6 hotfix | Dashboard splash never advanced past "Starting Clauge…"

**Trigger:** Adnan ran `brew upgrade --cask clauge` ~5 minutes after v0.9.5 tag was pushed. Hit a stuck splash showing "Failed to start Clauge / The local server didn't respond within 30 seconds" on every launch. The local server was actually running fine (`pgrep -alf clauge` showed PID alive; `lsof -nP -iTCP:3456 -sTCP:LISTEN` showed the port held; `curl http://127.0.0.1:3456/api/health` returned 200 with `version: "0.9.5"`).

**What went wrong:** The v0.9.5 B.6 ClaugeBridge migration (commit `c0b8633`) changed `popover/splash.js` to call `window.ClaugeBridge.getServerPort()` and `window.ClaugeBridge.restartApp()` instead of raw `window.__TAURI__.core.invoke()`. But `popover/splash.html` only included `<script src="splash.js">` — it never loaded `lib/tauri-bridge.js`. So `window.ClaugeBridge` was undefined when `splash.js` ran. The new guard `if (!window.ClaugeBridge || !ClaugeBridge.isTauriAvailable()) return;` short-circuited both the eager port-check and the polling fallback. After the 30-second hard timeout, the splash showed its error UI. Menubar popover was unaffected — `popover/index.html` already loaded the bridge correctly (added in v0.9.4).

**Lesson:** When migrating JS to depend on a facade (e.g., `window.ClaugeBridge`), every HTML page that loads the migrated JS must independently load the facade script. There is no inheritance between sibling HTML pages — `popover/index.html` loading the bridge does not help `popover/splash.html`.

**Prevention:**
- Before migrating ANY JS file to use the facade, grep every HTML page that loads it: `rg -n 'script.*<filename>\.js' --type html`.
- For each HTML page found, verify it ALSO includes `<script src="lib/tauri-bridge.js">` BEFORE the migrated JS.
- Add a validator at `scripts/validate-html-facade-loads.cjs` (queued for v0.9.7) — scan HTML for JS that uses `ClaugeBridge.*` and lint-fail if the bridge isn't loaded first.
- For Tauri specifically: before tagging a release, smoke-test the production DMG (built via `cargo tauri build`), not just `cargo tauri dev`. Dev mode raced through the splash via the `sidecar-ready` Tauri event path, which doesn't use the bridge — that masked the bug.

**Hotfix:** v0.9.6 — one line in `popover/splash.html`:
```html
<script src="lib/tauri-bridge.js"></script>
<script src="splash.js"></script>
```
Tagged + pushed direct to main 2026-05-26 ~21:35 BDT (no PR because urgent + obviously correct).

**Cross-references:**
- Auto-memory: [project_v0_9_5_splash_regression](~/.claude/projects/-Users-adnanrashid-Projects-clauge/memory/project_v0_9_5_splash_regression.md) — full timeline and timing-race analysis.
- Auto-memory: [feedback_html_js_dep_loading](~/.claude/projects/-Users-adnanrashid-Projects-clauge/memory/feedback_html_js_dep_loading.md) — the general migration rule.
- Global rulebook: `~/.claude/AGENT_LEARNINGS.md` — same lesson promoted as cross-project applicable.
- AGENTS.md landmine #20 (queued for v0.9.7 — "HTML pages hosting JS that uses `window.ClaugeBridge.*` MUST load `lib/tauri-bridge.js` first").
