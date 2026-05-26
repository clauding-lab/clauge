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
