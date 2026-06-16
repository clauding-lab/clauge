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

## 2026-06-16 — v1.3.3 | A peer agent's "merged-ready, tests pass" PR was actually RED on full CI

**Trigger:** Copotron (the Discord/VPS Claude) diagnosed + fixed the weekly-forecast over-reaction, opened desktop PR #56 + iOS PR #14, and reported *"55 projection tests pass, merged-ready."* Picking it up on the Mac to merge + ship, a pre-merge `gh pr checks 56` showed **both** CI jobs RED (`check` + `js-tests-windows`).

**What went wrong:** Copotron ran only the focused projection-vector tests (like a bare `node --test test/projection.test.js` → green), not the full `npm run check`. The fix switches the weekly (sevenDay) forecast from the recent-burst rate to the window-average — a behavioral change the alert engine reads — so 2 `test/alert-engine.test.js` cases that pinned the OLD weekly state (via a "flat recent history → safe" trick that only feeds the recent-rate path) flipped from `approaching:80` to `willHit` and failed. The originating agent never ran the downstream suite, and its self-reported green was taken at face value in the handoff.

**Lesson:** Never merge another agent's PR on its self-reported green — re-run the FULL gate (`gh pr checks <n>` / `npm run check`) yourself first. A peer agent's "tests pass" is exactly as untrustworthy as your own focused-test green (landmine #29); cross-agent handoffs lose the "did you run the whole thing" context.

**Prevention:** (1) On any inbound PR — peer-agent or human — gate the merge on `gh pr checks <n>` GREEN, never on the PR description. (2) A change to `lib/projection.js` predictably ripples into `test/alert-engine.test.js` (the engine consumes projection `.state`; the flat/steep-history fixture trick now only controls ≤5h windows). (3) iOS has NO CI — run the FULL `xcodebuild test` (all of ClaugeTests), not `-only-testing` one suite, before merging an iOS mirror (here 199/199 confirmed no equivalent breakage).

**Hotfix:** Updated the 2 lagging alert-engine expectations to the correct new behavior (`willHit:sevenDay`) + refreshed the fixture comment; pushed to the PR branch; full `npm test` 475/475 + CI green; merged #56 + #14; shipped v1.3.3.

**Cross-references:** reinforces AGENTS.md landmine #29 (run the full CI command before claiming green); global rulebook 2026-06-16 (cross-agent handoff verification); auto-memory `project_active_guardrail_roadmap.md`.

## 2026-06-13 — v1.3.0 | Release Windows job failed on a POSIX-only test; the PR gate is macOS-only

**Trigger:** The v1.3.0 release tag fired `release.yml`, whose **Windows x64** matrix job failed at "Run JS unit tests." Every PR had been green. The Windows build had never run the JS suite until the release.

**What went wrong:** `check.yml` (the PR gate) runs `runs-on: macos-latest` only, but `release.yml` also builds a Windows artifact. `test/usage-history.test.js` did `chmod(dir, 0o500)` then expected `appendFile` to `EACCES` — Windows does not enforce POSIX directory permissions, so the write succeeded and the assertion failed. Latent on `main` since the recorder landed (#39); no release ran between then and v1.3.0, and the PR gate never exercised Windows. The macOS DMG published but the Windows build and the gh-pages `latest.json` mirror (gated on the full matrix) were skipped → a partial, stuck release.

**Lesson:** The platforms your RELEASE builds must be a subset of what your PR gate TESTS — otherwise the release gate is your first integration test on the untested platform, the most expensive place to find a break (tag dance + partial-publish cleanup). And POSIX file-permission tests (`chmod 0o000/0o500` → expect `EACCES`) are not portable: skip on `win32` or force the failure portably (target a path whose parent is a regular file → `ENOTDIR` everywhere).

**Prevention:** (1) PR #49 skips the offending case on `win32` (graceful-failure stays covered on macOS/Linux). (2) Added a `js-tests-windows` job to `check.yml` (`npm test` on `windows-latest`) so JS portability breaks are caught pre-merge — add it to the branch's required status checks to make it blocking. (3) Recovery from a partial matrix release: delete the partial GitHub Release + tag (`gh release delete <tag> --cleanup-tag`), merge the fix, re-tag the same version at the fixed commit, re-push.

**Hotfix:** PR #49 (skip-on-win32) + clean re-tag of v1.3.0 (deleted the partial release/tag, re-tagged at the fixed commit → all 4 jobs green, `latest.json` flipped to 1.3.0).

**Cross-references:** global `~/.claude/AGENT_LEARNINGS.md` (same date); companion OOM entry below; `check.yml` `js-tests-windows` job.

## 2026-06-13 — v1.3.0 | Cold-start OOM: unbounded `loadAllSummaries` on a large ~/.claude

**Trigger:** Pre-release smoke of sub-projects A+B (the v1.3.0 ship). A freshly-started sidecar, hit with any spend query, OOM-crashed — ~3.97 GB RSS in ~50s — on the real 1.1 GB / 2647-file `~/.claude`. The running production app uses ~57 MB.

**What went wrong:** `SessionStore.loadAllSummaries()` (`lib/session-store.js`) did an unbounded `Promise.all` over every session file. On a cold in-memory cache it parsed the entire transcript corpus at once, blowing past node's ~4 GB default heap. Pre-existing — predates A/B — and reproduced through the old `/api/roi` with zero new code. Dormant in normal use because the per-file mtime cache warms incrementally (no single run ever faced a full-corpus cold parse) and warm reads are stat-only (~57 MB).

**Why it became a release blocker now:** sub-project B's Rust alert poller hits `/api/alerts/pending` → `buildLiveProjection` → `loadAllSummaries` every 30s from app launch, with no user interaction. On a heavy account the first poll triggers the cold parse → OOM → sidecar respawn → cold again → crash loop. An always-on background caller turned a latent, user-triggered, dashboard-only OOM into an every-launch crash.

**Lesson:** (1) Smoke the sidecar on a REAL heavy `~/.claude`, not dev-sized data — cold-start memory bugs only surface at scale. (2) Adding an always-on poller to a shared, expensive code path changes that path's risk profile even when the path itself is unchanged — re-smoke the path under the new caller. (3) `Promise.all(arr.map(...))` over an unbounded set is a memory landmine; cap concurrency. (4) "Pre-existing, not my change" ≠ "not my problem to ship-block" — the new feature is what made it fire.

**Prevention:** `loadAllSummaries` now parses in bounded batches of `SUMMARY_LOAD_CONCURRENCY` (8). `test/session-store.test.js` pins the cap (mutation-verified: fails against the unbounded version). AGENTS.md landmine #41 added. Verified end-to-end on the real 1.1 GB account: cold start survives at ~2.0 GB peak (single load and 5× concurrent both ~2.0 GB — the per-file cache dedups overlap).

**Hotfix:** Folded into v1.3.0 (PR #47) alongside the A+B release, rather than a separate v1.2.1 — Adnan's call (one fix covers the pre-existing bug and unblocks the always-on poller).

**Cross-references:** AGENTS.md landmine #41; auto-memory `project_active_guardrail_roadmap`; global `~/.claude/AGENT_LEARNINGS.md` (same date).

## 2026-06-12 — v1.2.0 | Popover Quit dead since v0.5.0: the comment described intent, not reality

**Trigger:** Post-launch review board flagged the popover ✕ Quit button doing nothing; recon confirmed `{cmd:'quit'}` lands in `handle_script_message`'s catch-all (unknown script message cmd=quit).

**What went wrong:** The v0.5.0 native-popover migration moved quit from Tauri IPC to the webkit message channel, but the Rust match arm was never written. Three artifacts described the nonexistent path as real: `popover.js`'s header comment listed quit as a supported message, `ipc::quit_app` stayed registered in `lib.rs` (invokable from nowhere — the native popover has no Tauri IPC), and the validator comment at `scripts/validate-ipc-triple-register.cjs` exempts `quit_app` as "popover-only".

**Lesson:** A comment, a registered command, or a validator exemption describing a message protocol is not evidence the other side implements it. When a channel handler has a catch-all, every documented command needs a check against the real handler's match arms.

**Prevention:** v1.2.0 adds the missing `"quit"` arm. Before trusting any JS-side doc about webkit-channel commands, grep `native_popover.rs::handle_script_message` for a matching arm. (`openSettings`'s `cmd:'open_settings'` is the SAME class of trap — unhandled in Rust, zero callers since v0.9.4; do not rewire it without adding the arm.)

**Hotfix:** None needed — shipped broken for ~10 minor versions with the tray-menu Quit as the working path; fixed in v1.2.0.

**Cross-references:** AGENTS.md landmines #9 (no macOS E2E), #11 (popover invariants); clauge-ios AGENT_LEARNINGS "a documented-dead code path that is still REACHABLE is a shipped bug" (same family, 2026-06-11).

## 2026-06-11 — v1.1.0 | iCloud per-container upload wedge: the Mac published every 5 minutes into a container that hadn't uploaded for a day

**Trigger:** Adnan's iPhone Analytics tab stuck on "Synced 1 day ago. Open Clauge on your Mac to update." despite the Mac app running and publishing (seq incrementing).

**What went wrong:** macOS's iCloud daemon (bird) lost upload authorization for the `iCloud.com.clauding.clauge` container ONLY — general iCloud Drive uploaded instantly, container downloads still worked, quota was fine, no Apple status incident. Every coordinated write SUCCEEDED locally (so the icloud_writer's two-layer error contract could never fire — the failure lives entirely inside bird, after our write returns). File-level truth via `URLResourceValues`: `uploaded=false, uploading=true, uploadError="Couldn't access your iCloud account…"`. Survived `killall bird` AND a fresh file record (delete + republish). Fixed by signing out of iCloud on the Mac and back in.

**Lesson:** a successful `NSFileCoordinator` write proves NOTHING about delivery — bird-level upload failures are invisible to the app's own logging, and `brctl status` can report "caught-up" while uploads are wedged. The only honest signal is the file's `NSURLUbiquitousItemIsUploadedKey` / `UploadingErrorKey` after the fact.

**Prevention:** the post-publish upload-state check belongs IN the product: after each publish tick, query `ubiquitousItemIsUploaded`/`UploadingError` on the written URL and surface `lastPublishedAt` + upload state in Settings (the deferred "iCloud sync health" feature from the 2026-06-10 review — this incident is its business case). Diagnostic ladder for recurrence: (1) `jq .generatedAt` the container file — fresh ⇒ pipe problem, not Clauge; (2) Swift `URLResourceValues` upload keys — the error string names it; (3) probe `com~apple~CloudDocs` to scope account vs container; (4) `killall bird` → fresh file record → iCloud sign-out/in.

**Hotfix:** none in code — user-environment fix (iCloud re-login). Verified end-to-end: fresh snapshot seq 604 `uploaded=true, uploadError=none`.

**Cross-references:** auto-memory `reference_icloud_container_upload_wedge.md`; AGENTS landmines #32-36 (the write path, which was NOT at fault); 2026-06-10 feature-review candidate "iCloud sync health end-to-end".

## 2026-06-02 — v0.9.10 | Phantom "Claude Design" usage bucket shipped after Anthropic removed it

**Trigger:** Adnan noticed the menu bar + dashboard still showed a "Claude Design" usage bar/ring at a permanent 0% after Anthropic dropped that weekly bucket around the Opus 4.8 release.

**What went wrong:** Clauge had speculatively built UI for an anticipated upstream bucket (codename `omelette` → public "Claude Design"). The render functions defaulted a missing window to 0% (`popover.js renderDesign`: `const pct = design?.pct ?? 0`) and the dashboard ring was a static gauge keyed off `plan.sevenDayOmelette`. When the live `/api/usage` payload returned `claudeDesign: null` (and `unknownSevenDayKeys: []` — Anthropic isn't even sending the key anymore), both surfaces rendered a phantom "0% used · resets —". A second, methodology gap: the first verification hit the stale `public/popover/` build mirror instead of the edited `popover/` source, so the fix looked like it didn't work until the mirror was regenerated.

**Lesson:** Never render a usage/quota category from a value that can legitimately be absent — gate the display on data presence, not a `?? 0` default. Speculative UI for upstream API fields that may never ship (or later get removed) becomes a phantom.

**Prevention:** Hide a section/ring when its bucket is null/absent (data-gated render); keep the resolver so it reappears automatically if the bucket returns. Verify render changes against REAL `null`-bucket data (e.g. the live `/api/usage`), and account for the `popover/` → `public/popover/` mirror (landmine #30) when testing a running dev sidecar.

**Hotfix:** Branch `fix/hide-claude-design-bucket` (commit `2ccfabc`): popover section is `hidden` when `claudeDesign` is null; dashboard ring is conditionally omitted with a shape-flag guard (no re-render flicker, per the v0.9.9 lesson). Bundled the dashboard ring rebalance (centered count-adaptive flex, 88→120px, wider gaps) + a local reset-time line beneath each "resets in …" countdown. Full `npm run check` green; verified live via Playwright on both surfaces.

**Cross-references:** AGENTS.md landmine #30 (popover/ vs public/popover/ mirror); auto-memory `project_claude_design_phantom_fix`; global `~/.claude/AGENT_LEARNINGS.md` (the data-gating rule generalizes).

## 2026-06-01 — v0.9.10 | CI red on `cargo fmt` after Apple acceptance — "5 validators pass" ≠ full `npm run check`

**Trigger:** Apple ACCEPTED build 5. On resuming to merge PR #11 → main, `gh pr checks 11` showed the `check` workflow RED. The prior session's close-out had said "all 5 repo validators pass," which read as CI-clean. It wasn't — the red gate had sat undetected from the build-5 push (2026-05-30) until the merge attempt (2026-06-01).

**What went wrong:** CI runs `npm run check` = `check:validators && check:fmt && check:lint && check:rust-test && npm test`. The build-5 hand edits across `autostart_mas.rs`, `ipc.rs`, `port_discovery.rs`, `security_scoped_bookmark.rs`, and `sidecar.rs` were never run through `cargo fmt`, so `check:fmt` (`cargo fmt --check`) failed and the `&&` chain short-circuited — clippy/tests never ran. The session's "5 validators pass" referred only to `check:validators` (the 5 `.cjs` scripts), which is the FIRST of five links; it runs no formatter, linter, or tests. A green subset was mistaken for a green whole.

**Lesson:** A passing subset of checks is not a passing CI gate — before claiming "CI green" or merging, run the exact full command CI runs, not the quick local validators.

**Prevention:** `AGENTS.md` landmine #29 — the 5 `.cjs` validators are a SUBSET; the CI gate is `npm run check` (validators + `cargo fmt --check` + `cargo clippy -D warnings` + `cargo test` + `npm test`). Run `npm run check` locally before pushing a release branch or claiming CI-green (needs sidecar binaries at `src-tauri/binaries/`). Any close-out "checks pass" claim must name *which* checks ran. Hand edits to `src-tauri/src/*.rs` must be run through `cargo fmt` — it's CI's first, short-circuiting gate.

**Hotfix:** `cargo fmt` on the 5 files → commit `ae922b8` (`style(mas): apply cargo fmt to MAS-flavor sources`, formatting-only, no behavior change) → full `npm run check` green locally (clippy `-D warnings` + 65 rust + 245 node tests) → CI green (run 26748593024) → PR #11 merged to `main` (merge commit `0445e04`). Build 5 itself was unaffected — the MAS pkg Apple accepted was already built + signed; the fmt drift only blocked the repo-side merge.

**Cross-references:** `AGENTS.md` § 29; auto-memory `feedback_full_check_before_merge`; global rulebook 2026-06-01 entry. Follows the build-5 acceptance recorded in `project_v0_9_10_build5_second_rejection`.

---

## 2026-05-31 — v0.9.10 build 5 | Apple's SECOND rejection — three findings, including one the prior fix CREATED

**Trigger:** Apple rejected v0.9.10 **build 4** (2026-05-30) with three findings: **2.4.5(iii)** (auto-launches at login without consent), **3.1.1** (appears to sell/access paid content via non-IAP), and **4 / Design** (a window cuts off text — the popover heatmap).

**What went wrong:**
- **2.4.5(iii) was self-inflicted by the PRIOR session's fix.** v0.9.10 added `SMAppService` launch-at-login (correct mechanism, landmine #26) but wired it to **auto-enable on first launch** (`lib.rs` called `autostart_mas::enable()` unconditionally; the comment literally said "default ON") with the wizard only showing an opt-OUT *notice*. Making the feature *work* introduced a *consent* violation. Apple forbids auto-launch without explicit consent.
- **3.1.1 was a reviewer misread** of the Settings field "Subscription cost (monthly) $200" — a user-entered ROI input, not a product for sale. Clauge has zero payment infrastructure (verified: no StoreKit/Stripe/IAP anywhere). Product-y wording ("subscription cost", "subscription value dashboard", "Return on sub") on a *config input* invited the misread.
- **Design 4** — the popover sized to content via a one-shot `resizeToContent()` that ran in the refresh `finally` block, BEFORE the async `refreshHeatmap()` painted the 180-day grid, and **bailed entirely** (`return`) when content exceeded the 1200px cap instead of clamping. So the heatmap rendered taller than the measured popover and the `overflow:hidden` clipped it.
- **The prior pre-upload audit (14 agents) PASSED build 4** and missed all three. It checked known-risk dimensions but did not model a skeptical reviewer on a fresh Mac with empty `~/.claude` clicking every control.

**Lesson:**
- **Making a feature work ≠ making it App-Store-compliant.** For anything that touches startup, background execution, or payments, the *default/consent model* is the compliance surface — default to opt-in, register only on explicit user action.
- **Never use product/commerce vocabulary ("subscription", "plan cost", "buy") for a user-config input or a passive readout** — a reviewer skims labels out of context. Frame as the user's own external cost + state "never sells/processes payments".
- **One-shot layout measurement loses to async-rendered content.** Re-measure after async renders complete; clamp into bounds instead of bailing; add a scroll safety net so text can never clip.
- **A pre-submission audit must role-play the reviewer** (fresh machine, empty data, click every control), not just tick known dimensions — that's the only lens that would have caught all three.

**Prevention:** `AGENTS.md` landmine #28 (MAS launch-at-login must be opt-in; distinct from #26's mechanism). Build-5 fixes: `lib.rs` first-launch autostart block now `#[cfg(not(feature="mas"))]`; wizard Step 3 opt-in toggle (default OFF); `set_autostart`/`get_autostart` triple-registered so wizard + dashboard drive the flavor-correct path; relabel of every "subscription"/"sub" surface + a no-payments disclaimer; popover `resizeToContent()` re-called after heatmap render + clamp + `overflow-y:auto`. A 4-lens adversarial reviewer-seat audit (one lens = "fresh-Mac completeness critic") replaced the dimension-checklist audit — it caught a **dead popover autostart toggle** (hidden for build 5) and a missed **"Return on sub"** label the targeted fixes alone left behind.

**Verified (2026-05-31, sandboxed `--local-test` build):** `/api/health` → real `/Users/adnanrashid/.claude`, `/api/usage` → live data (helper + `CLAUDE_DIR` forward still good); served dashboard HTML shows "Your Claude plan cost" + no-payments line, old "Subscription cost"/"Return on sub" gone; build compiles clean (both flavors), all 5 repo validators pass; `.app` codesign-valid, 2 Mach-Os, helper carries app-sandbox+inherit. Autostart no-auto-register verified by code-proof + audit (empirical `sfltool` confounded by a stale enabled test-build login item from the prior session that can't be reset — TCC-blocked — and must be removed via System Settings).

**Hotfix:** Build 5, `bundleVersion` 4 → 5, marketing version unchanged (0.9.10). Branch `feat/mas-on-v0.9.9`, PR #11 (unmerged). Resubmission + Resolution Center reply (`SS/appstore/APP_REVIEW_REPLY_build5.txt`) pending Adnan in App Store Connect.

**Cross-references:** `AGENTS.md` § 28; auto-memory `project_v0_9_10_build5_second_rejection`. Plan-tier auto-detect (a v0.9.11 follow-up greenlit this session) is specced at `docs/superpowers/specs/2026-05-30-plan-tier-autodetect-design.md`.

---

## 2026-05-29 — v0.9.10 | MAS launch-at-login silently failed (LaunchAgent in sandbox) → SMAppService

**Trigger:** Pre-upload adversarial audit of the v0.9.10 resubmission (the completeness critic) flagged that the onboarding wizard claims "Clauge has been added to your login items," but the app registers autostart via `tauri-plugin-autostart`'s LaunchAgent — which a sandboxed app cannot write where launchd scans.

**What went wrong:** `app.autolaunch().enable()` (LaunchAgent backend) writes `~/Library/LaunchAgents/<app>.plist`. Under the App Sandbox `$HOME` is redirected, so the plist lands in `~/Library/Containers/com.clauding.clauge/Data/Library/LaunchAgents/` — a path launchd never scans. The call returns `Ok` (the write INTO the container succeeds), so nothing logged an error, but the login item never existed. The wizard's "added to your login items" copy was therefore false on MAS, and launch-at-login simply never happened. A "success" return masked a total no-op. The plugin was also registered + enabled unconditionally (not cfg-gated), so the MAS build attempted this dead path on every first launch.

**Lesson:**
- **macOS-specific:** a sandboxed app's launch-at-login MUST use `SMAppService` (macOS 13+), not a LaunchAgent plist — the sandbox redirect makes LaunchAgent a silent no-op.
- **Generalizable:** a convenience API returning success is NOT proof of the real-world effect under platform restrictions. Verify the EFFECT (did the login item actually appear?), not the return code. Here the LaunchAgent path and the SMAppService path BOTH return `Ok`; only `sfltool dumpbtm` distinguishes a real registration from a no-op.

**Prevention:** `AGENTS.md` landmine #26. New `src-tauri/src/autostart_mas.rs` registers via `SMAppService.mainApp` (`objc2-service-management`), cfg-gated: MAS uses SMAppService, DMG/Windows keep LaunchAgent. Runtime macOS-13 guard (`NSProcessInfo::isOperatingSystemAtLeastVersion`) keeps `minimumSystemVersion` at 12.0. **Verified 2026-05-29** on a sandboxed local-test build: `sfltool dumpbtm` showed a new `Type: app`, `Flags: [ sandboxed ]`, `Disposition: [enabled, allowed]` item for `com.clauding.clauge` — distinct from the DMG's `legacy agent` entry. The dashboard's real-data path was unaffected (regression check: `/api/health` → real `~/.claude`, `/api/usage` → live data).

**Hotfix:** Folded into v0.9.10 build 4 (rebuilt after the audit).

**Cross-references:** `AGENTS.md` § 26; global `~/.claude/AGENT_LEARNINGS.md` 2026-05-29 (success-≠-effect-under-sandbox); auto-memory `project_v0_9_10_apple_issue_2_wizard_race.md`. Surfaced by the pre-upload audit workflow's completeness critic — a finding none of the seven primary review dimensions covered.

---

## 2026-05-29 — v0.9.10 | The real Apple 2.1(a) fix — sandboxed sidecar couldn't boot (helper.app + inherit + CLAUDE_DIR env-forward)

**Trigger:** Building the sandboxed MAS flavor for the v0.9.10 resubmission — after the wizard-race fix (2026-05-28 entry below) was already in hand. Transporter rejected the build (HTTP 409, "App sandbox not enabled" on every Mach-O), forcing an architectural rebuild that revealed the wizard race was NOT the load-bearing cause of Apple's 2.1(a) rejection.

**What went wrong (two layers, neither was the wizard):**

1. **The SEA sidecar couldn't boot under the App Sandbox.** The Node SEA is a ~220 MB *standalone* Mach-O dropped at `Contents/MacOS/clauge-server`. Transporter statically requires `com.apple.security.app-sandbox` on every Mach-O — but a standalone Mach-O that *declares* app-sandbox with no embedded `Info.plist` SIGTRAPs at runtime in `libsystem_secinit::_libsecinit_appsandbox.cold.9` (`SYSCALL_SET_USERLAND_PROFILE`), because secinitd can't set up a per-binary sandbox container without a `CFBundleIdentifier`. So the binary was caught between a static gate (must declare app-sandbox) and a runtime gate (declaring it crashes). Apple's reviewer saw the blank window because the sidecar process was crash-looping, not (only) because the wizard opened early.

2. **After it booted, granted data didn't reach it.** Wrapping the binary in `Contents/Helpers/Clauge Helper.app/` (its own `Info.plist` + `CFBundleIdentifier=com.clauding.clauge.helper`) and adding `com.apple.security.inherit=true` got the helper booting and the dashboard rendering — but `/api/health` still reported the sandbox-redirected empty `~/.claude`. The MAS spawn path had been refactored from Tauri's shell plugin (`app.shell().sidecar(...)`, which implicitly inherits the parent env) to a raw `tokio::process::Command`, which set only `NO_OPEN=1`. The bookmark-resolved path lives in a Rust `OnceLock` (`MAS_CLAUDE_DIR`), not in the OS env, so the helper never learned where the real data was. A dashboard that renders but shows no data is itself a 2.1(a) re-rejection waiting to happen.

**Lesson (project + generalizable):**
- **A sandboxed *bundled helper binary* needs its own `.app` bundle** — `Info.plist` + `CFBundleIdentifier` + `com.apple.security.inherit=true`. `inherit` makes it attach to the parent's sandbox container (inheriting entitlements + the security-scoped bookmark) instead of getting a fresh per-binary container that secinitd can't provision. This is the Apple-documented pattern (Chrome/Electron helpers).
- **When you replace a framework's process-spawn helper with a raw OS spawn, you lose its implicit env inheritance.** Tauri's `shell().sidecar()` arranged the child env; `tokio::process::Command` does not carry anything you don't explicitly set. Audit what the framework was doing for you before swapping it out — forward the needed env vars by hand.
- **Verify the *data path*, not just that the UI renders.** "Dashboard appears" ≠ "fix works." The empty-data state looked like success on a screenshot.

**Prevention:**

1. `AGENTS.md` landmine #24 (helper.app + inherit + inside-out signing + first-spawn transient) and #25 (explicit env-forward when bypassing the shell plugin) — both already committed (`762ba72`).
2. `scripts/build-mas-clean.sh` owns the helper.app wrap + inside-out sign (helper binary → helper bundle → main bundle; no `--deep`).
3. **End-to-end sandboxed local-test verification before Transporter:** build with `--local-test`, launch, then `curl /api/health` (expect real `~/.claude`, not the container-redirected path) AND `curl /api/usage` (expect live plan + spend data). Compilation + unit tests are necessary but NOT sufficient — they passed the whole time the data path was broken.

**Hotfix:** v0.9.10 build 4. Helper.app wrap + `com.apple.security.inherit=true` (`entitlements-sidecar.mas.plist`), MAS spawn via `tokio::process::Command` with explicit `CLAUDE_DIR` forward in `spawn_native_helper` (`sidecar.rs`). **Verified end-to-end on a sandboxed local-test build (2026-05-29):** PID 15001 running from `Clauge Helper.app/Contents/MacOS/clauge-server`, no separate `com.clauding.clauge.helper` container (inherit working), `/api/health` → real `/Users/adnanrashid/.claude`, `/api/usage` → live data (5h plan 5%, extra-usage $19.60/$20, balance $78.63).

**Honest diagnostic note:** the wizard race was the first hypothesis (~70% confidence, recorded below on 2026-05-28) and could not be confirmed without a sandbox repro. Actually building the sandboxed flavor was the repro — and it showed the deeper cause. The wizard fix is correct and shipped as defense-in-depth; it was not retracted. This is a textbook case of a confident-looking diagnosis from code reading that only resolved once the real artifact was built and run.

**Cross-references:**

- Project landmines: `AGENTS.md` § 24 + § 25.
- Recontextualizes the 2026-05-28 wizard-race entry below (preserved as a point-in-time observation per the no-delete rule).
- CHANGELOG: `[0.9.10]` "Note on the rejection diagnosis" + the two architectural "Fixed" bullets.
- Global: `~/.claude/AGENT_LEARNINGS.md` 2026-05-29 entry (the framework-spawn-loses-env-inheritance generalization).
- Auto-memory: `project_v0_9_10_apple_issue_2_wizard_race.md` (corrective footer).
- Branch: `feat/mas-on-v0.9.9`; PR #11. ASC submission `32193453-1524-407a-b705-c16ae62fbbd3`, build 4.

---

## 2026-05-28 — v0.9.0 → v0.9.10 | Apple Mac App Store rejection — wizard race condition

> **Recontextualized 2026-05-29 (see entry above):** this entry captured the first-hypothesis diagnosis (wizard race). Building the sandboxed flavor later revealed the load-bearing cause was the sidecar's inability to boot under the App Sandbox (helper.app + inherit) plus a `CLAUDE_DIR` env-propagation bug. The wizard fix below is correct and shipped, but as defense-in-depth, not the primary 2.1(a) fix. Kept verbatim as a point-in-time observation.

**Trigger:** Apple App Review rejected v0.9.0 build 3 (in review since 2026-05-19, response 2026-05-28 02:51 BDT) under two guidelines:

- **Guideline 2.4.5(i):** justification needed for `com.apple.security.network.server` entitlement. Paperwork — replied in App Store Connect explaining the loopback-only TCP listener for the Tauri webview ↔ Node sidecar IPC channel. No binary change needed.
- **Guideline 2.1(a):** "the app does not load its content after launch." Showstopper. Tested on a clean MacBook Pro 14" running macOS 26.5. No screenshot or screen recording attached.

**What went wrong:** The first-launch onboarding wizard `WebviewWindow` opens 500 ms after `tauri::Builder::setup()` runs (`lib.rs:159` pre-fix), with URL `http://127.0.0.1:3456/onboarding/index.html`. This URL is served by the Node SEA sidecar, which at module top-level in `server.js:79,84` `await`s `loadPriceTable()` (8 s timeout HTTP fetch to raw.githubusercontent.com via `lib/cost-calculator.js:80`, with bundled fallback) AND `usageStore.load()` BEFORE `listenWithRetry(PORT)` at `server.js:678` actually binds the port. On cold launch in sandbox the sidecar takes **1–8 seconds** to bind — far longer than the 500 ms wizard delay.

The wizard webview hit `ERR_CONNECTION_REFUSED` and stayed in error state. No retry, no listener for the `sidecar-ready` event (which sidecar.rs emits when PORT_MARKER is captured). Apple's reviewer saw a blank "Welcome to Clauge" window and rejected.

Compounding bug at `lib.rs:178-181` pre-fix: if `WebviewWindowBuilder::build()` itself errored (rather than just the webview's initial load failing), the handler stored `onboarding_completed=true` permanently — meaning the wizard would never appear on any subsequent launch either, even after the bug was fixed at the source. A transient race got promoted into a permanent dead state.

The dashboard window doesn't have this race — it uses bundled `splash.html` via `WebviewUrl::App("splash.html")` (windows.rs:27), and the splash JS listens for `sidecar-ready` before navigating to the sidecar URL. The pattern existed in the codebase for the dashboard since v0.8.1; it just hadn't been extended to the wizard.

**Lesson (project-specific):** Any `WebviewWindow` that loads from the sidecar HTTP origin (`http://127.0.0.1:PORT/...`) MUST gate its `build()` call on a `sidecar-ready` event listener, NOT on a fixed `tokio::sleep` delay. The sidecar's cold-start latency in sandbox is variable (1–8 s) and the 500 ms / 1 s / 2 s margins look fine in dev but break under App Review's first-launch conditions. Build failures during the wizard spawn must NEVER permanently disable the wizard — log and let the next launch retry.

**Lesson (generalizable):** Race conditions between the frontend window opening and backend HTTP readiness in dev-time tooling produce blank UI that gets misdiagnosed as "app broken" by external reviewers (Apple's App Review, App Store testers, novice users) — they don't know to wait, click again, or reload. Either gate the window open on a backend-ready signal, OR open the window pointing at a bundled wait-screen that polls the backend, NEVER trust a sleep timer.

**Prevention:**

1. Codified as AGENTS.md landmine #23 — "WebviewWindow URLs pointing at the sidecar HTTP origin MUST listen for `sidecar-ready` before opening."
2. The `spawn_wizard_window_once` helper at `src-tauri/src/lib.rs:27-69` is the canonical pattern: takes `&AppHandle`, `port`, and an `AtomicBool` race-guard; called from a `sidecar-ready` event listener AND a 30 s timeout fallback; on `build()` error, logs only — never mutates the `onboarding_completed` flag.
3. External-discovery branch (`port_discovery::DiscoveryResult::External`) now also emits `sidecar-ready` so users with a pre-running clauge-server hit the same listener path.

**Hotfix:** v0.9.10 shipping for App Store resubmission (build 4). The MAS plumbing port from `clauding-lab/mas-implement-session` onto current main + the wizard race fix are bundled in one release rather than landing v0.9.0 separately, so MAS users get v0.9.9's polish + flicker fix + landmines #21/#22 alongside the sandboxed flavor.

**Cross-references:**

- Project landmine: `AGENTS.md` § 23 (wizard race rule).
- Global: `~/.claude/AGENT_LEARNINGS.md` (the generalizable lesson about frontend-window-vs-backend-readiness races).
- Auto-memory: `project_v0_9_10_apple_issue_2_wizard_race.md` (point-in-time observations) + `feedback_webview_sidecar_race.md` (cross-project rule).
- Commits: `329fa30` (fix), TBD (release prep).
- PR: #11 (draft, feat/mas-on-v0.9.9 → main).

---

## 2026-05-27 — v0.9.8 → v0.9.9 | Dashboard plan-card flickered every 60 seconds

**Trigger:** Adnan asked "still slight flickering of the dashboard exists. investigate" after v0.9.8 shipped. Reproduced against the user's live sidecar on port 3456 with a Playwright `MutationObserver` covering `#plan-body`, `#plan-meta`, `#plan-status-tag`, `#plan-inline`, and the finance-side spans. Across two 60-second cycles the observer recorded 38 mutations per tick at exact 60s intervals — even when the underlying `/api/usage` payload was byte-identical (e.g. `#claude-balance-val` text replaced `"78.63"` with `"78.63"`).

**What went wrong:** The plan auto-refresh interval at `public/app.js:1069-1077` calls `renderPlanCapacity()` + `renderFinanceSide()` every 60s. Both functions unconditionally rebuilt entire DOM regions by reassigning the `innerHTML` property:

- `#plan-meta` (line 282 pre-fix) — destroyed the `<span class="dot-live">` and created a new one. The dot's CSS `animation: pulse 2s ease-in-out infinite` (styles.css:910) restarted from frame 0 each minute — the dominant user-visible flicker, perceived as a faint brightness snap on the green sync dot.
- `#plan-body` (line 263 pre-fix) — destroyed and reparsed all 4 SVG ring-cards.
- `#plan-inline` (line 288 pre-fix) — destroyed 19 children (4 mini SVG rings + separators + numbers).
- `renderFinanceSide` reassigned `.textContent` on 7 spans regardless of whether the underlying values changed — each assignment replaces the existing text node with a fresh one (Node.textContent setter spec), firing childList mutations and a layout/paint.

The result was a ~30-DOM-mutation churn cycle per minute, perceptible because of the animation restart even when the values stayed identical.

**Lesson:** When an auto-refresh path rebuilds a parent region by reassigning the `innerHTML` property, EVERY child of that region gets destroyed and recreated — including any elements with running CSS animations. Their animations restart at frame 0. If the parent contains a long-lived animated element (live-status dot, spinner, pulsing badge), reassigning `innerHTML` will flicker the animation every refresh. Split the render into a structural phase (innerHTML, only on shape transitions) and a surgical phase (in-place text/attribute writes that fire characterData mutations, not childList).

**Prevention:**

- `public/app.js` now exposes `setTextIfChanged(el, val)` and `setAttrIfChanged(el, name, val)`. The text helper prefers `el.firstChild.data = val` over `el.textContent = val` when the element has exactly one text-node child — `Text.data` assignment fires `characterData` (not `childList`), so siblings stay untouched and their CSS animations are preserved.
- `renderPlanCapacity` is gated by three module-level flags (`__planCardMode`, `__planStatusTone`, `__planInlineHasBalance`) so the structural rebuild only fires on placeholder ↔ ingested or balance-line-appearing transitions.
- Three new helpers (`updateBigRings`, `updatePlanMeta`, `updatePlanInline`) walk the existing DOM on every other tick. `updatePlanMeta` walks past `.dot-live` and mutates only the trailing text node's `.data` — the pulse element is never touched again after the first paint.

**Hotfix:** v0.9.9. PR #7 (`fix/dashboard-plan-flicker`) shipped the surgical-update refactor; v0.9.9 packages it with version bumps + this AGENT_LEARNINGS entry + AGENTS.md landmine #21 (the Cargo.lock-in-version-bumps codification from the v0.9.8 retrospective). Verified against fresh sidecar on PORT=3499 with the same MutationObserver: 6–7 mutations per tick across three 60s cycles (all legitimate `characterData` on `synced N ago` / `resets in X` relative-time text), zero `childList` mutations on the plan-card regions, `.dot-live` element identity preserved across all ticks (`dataset.flickertag` survived).

**Cross-references:**

- **AGENTS.md landmine #21** (new, shipped together) — "Version bumps require Cargo.lock too" (different lesson, but bundled in this release because the v0.9.8 → v0.9.8 follow-up Cargo.lock PR existed only because of this gap).
- **AGENTS.md landmine #22** (shipped) — "Auto-refresh paths must NOT destroy long-lived animated children" — generalizes the lesson across all `setInterval`-driven re-renders, with the two-phase structural/surgical render pattern + verification recipe codified.
- **Global rulebook** — promoted the meta-lesson "auto-refresh by reassigning innerHTML restarts animations on every destroyed child; split structural + surgical updates" to `~/.claude/AGENT_LEARNINGS.md`.
- **Auto-memory** — new `project_v0_9_8_v0_9_9_plan_flicker.md` postmortem + new `feedback_innerhtml_animation_restart.md` cross-project rule.

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
