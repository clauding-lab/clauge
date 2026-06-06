# Changelog

## [1.1.0] — 2026-06-06

### Added

- **Companion sync to iPhone.** Clauge now publishes a small private analytics snapshot to your own iCloud so the new **Clauge — Token Analytics** app for iPhone can show the same usage on the go — ROI, spend, your 180-day activity heatmap, and by-model and by-project breakdowns. It refreshes automatically in the background (~every 5 minutes), stays in your own private iCloud, and contains only your locally-computed stats — no credentials, cookies, or API keys. Everything Clauge does on your Mac still runs locally; no account, nothing sold.

---

## [1.0.0] — 2026-06-02

### Added

- Local reset time shown beneath each "resets in …" countdown (popover + dashboard), in your local timezone.

### Changed

- Dashboard plan-usage rings: larger, centered, evenly spaced; the removed "Claude Design" bucket no longer renders a phantom 0%.

### Security

- Read-only local API restricted to the app's own loopback origins (a website you visit can no longer read your local usage/paths).
- Removed the home-folder path from `/api/health` and per-session file paths from `/api/sessions`.
- The app now only ever trusts the sidecar it launched itself (a port-squatter can no longer impersonate Clauge).

---

## [0.9.10] — 2026-05-29

### Build 5 (2026-05-30) — fixes for Apple's second rejection

Apple rejected build 4 on 2026-05-30 with three findings. All three are addressed here; the marketing version stays 0.9.10 (same App Store version, new build, `bundleVersion` 4 → 5).

- **Launch at Login is now strictly opt-in on MAS (Guideline 2.4.5(iii)).** Build 4 auto-registered Clauge as a login item on first launch (an opt-out model Apple forbids). The MAS first-launch auto-enable is removed; Launch at Login now registers via SMAppService ONLY when the user explicitly enables it — a default-OFF toggle in the onboarding wizard's "Other Settings" step, or the dashboard Settings toggle. DMG/Windows are unchanged (they still auto-enable; not App Store). In passing this fixed a pre-existing MAS bug where the dashboard autostart toggle drove the sandbox-no-op LaunchAgent plugin instead of SMAppService — `set_autostart`/`get_autostart` are now triple-registered (`APP_COMMANDS` + capabilities) and the dashboard toggle calls the flavor-correct path.
- **In-App Purchase clarification + relabel (Guideline 3.1.1).** Clauge is free and contains no IAP or payment mechanism of any kind; the reviewer misread the ROI cost input. The "Subscription cost (monthly)" field is relabeled **"Your Claude plan cost (monthly)"** with help text clarifying it is what the user already pays Anthropic, used only for the API-replacement estimate, and that "Clauge never sells plans or processes payments." The About blurb ("subscription value dashboard" → "plan-ROI dashboard"), the "Pricing source" row ("API rate source"), and the claude.ai sign-in copy (now explicitly read-only) were also clarified. A Resolution Center reply accompanies the resubmission.
- **Popover no longer clips text (Guideline 4 / Design).** The menu-bar popover clipped the bottom of the 180-day activity heatmap: it sizes to content via a JS→native resize, but that ran before the (async) heatmap rendered and bailed entirely on content taller than 1200px. Now it re-measures after the heatmap renders, clamps into the native range instead of bailing, and `body` has an `overflow-y: auto` safety net so content can never be clipped.
- **Engineering:** new `AGENTS.md` landmine #28 (MAS launch-at-login must be opt-in — distinct from #26's mechanism); `bundleVersion` 4 → 5.

---

**Mac App Store resubmission release.** Three things ship together: (1) the entire MAS flavor plumbing (~38 commits of v0.9.0 work) rebased onto current main so MAS users get v0.9.9's polish + flicker fix + landmines #21/#22 alongside the sandboxed flavor; (2) the **architectural** fix for Apple's Guideline 2.1(a) rejection of v0.9.0 build 3 — the sandboxed Node sidecar is now wrapped in its own `Clauge Helper.app` bundle with `com.apple.security.inherit=true`, which is what actually lets it boot under the App Sandbox and load the dashboard's content (plus a `CLAUDE_DIR` env-forward so granted data reaches it); and (3) defense-in-depth for cold launches — the first-launch wizard now waits for a `sidecar-ready` event instead of racing a fixed timer.

DMG users are unaffected (all MAS work is `#[cfg(feature = "mas")]`-gated; the wizard hardening improves cold-launch robustness but doesn't change DMG behavior in practice).

> **Note on the rejection diagnosis.** The original read of Apple's 2.1(a) ("app does not load its content after launch") was the wizard race below. Building the sandboxed flavor for resubmission surfaced the deeper cause: the sidecar couldn't boot under the sandbox at all (see the two architectural items first). The wizard fix is correct and shipped, but it is defense-in-depth, not the load-bearing fix. The earlier AGENT_LEARNINGS / CHANGELOG framing has been corrected accordingly.

### Fixed (Apple Mac App Store rejection)

- **Sandboxed sidecar now boots — `Clauge Helper.app` + `com.apple.security.inherit`.** The load-bearing fix for Guideline 2.1(a). The SEA Node sidecar is a ~220 MB Mach-O that Apple's Transporter rejects (HTTP 409) unless it declares `com.apple.security.app-sandbox` — but a *standalone* Mach-O that declares app-sandbox with no embedded `Info.plist` SIGTRAPs at runtime in `libsystem_secinit` (`_libsecinit_appsandbox`, `SYSCALL_SET_USERLAND_PROFILE`), because secinitd can't set up a per-binary container without a `CFBundleIdentifier`. Fix (the Apple-documented pattern Chrome/Electron use): wrap the binary in its own `.app` bundle at `Contents/Helpers/Clauge Helper.app/` so it carries an `Info.plist` + `CFBundleIdentifier=com.clauding.clauge.helper`, and give it `com.apple.security.inherit=true` so it attaches to the parent's sandbox container — inheriting the parent's entitlements and the security-scoped `~/.claude` bookmark — instead of getting its own. With this the helper boots cleanly and the dashboard renders fully. `scripts/build-mas-clean.sh` performs the wrap and inside-out signing (helper binary → helper bundle → main bundle).
- **Granted `~/.claude` data now actually reaches the sidecar — `CLAUDE_DIR` env-forward.** The MAS spawn path was refactored from Tauri's shell plugin (`app.shell().sidecar(...)`, which implicitly inherits the parent's environment) to a raw `tokio::process::Command`, which does not. The bookmark-resolved path lives in a Rust `OnceLock` (`MAS_CLAUDE_DIR`), not in the OS environment, so the helper kept reading the sandbox-redirected empty `~/.claude` even after a successful grant — the dashboard would render but show no data (a 2.1(a) re-rejection waiting to happen). Fix: `spawn_native_helper` now reads `MAS_CLAUDE_DIR.get()` at spawn time and forwards it as `CLAUDE_DIR`. Verified end-to-end on a sandboxed local-test build — `/api/health` reports the real `/Users/<you>/.claude` and `/api/usage` returns live plan + spend data.
- **First-launch wizard no longer races the sidecar (defense-in-depth).** Independently of the sandbox-boot issue, the wizard `WebviewWindow` opened 500 ms after launch with URL `http://127.0.0.1:3456/onboarding/index.html`, but the Node SEA sidecar takes 1–8 s to bind that port in sandbox (loadPriceTable HTTP fetch with 8 s timeout in `lib/cost-calculator.js:80`, then `usageStore.load()`, then serveStatic + Hono routes, then `listenWithRetry` at `server.js:678`). The wizard's webview got `ERR_CONNECTION_REFUSED` and stayed in error state — no retry, no listener for `sidecar-ready`. Worse: if `build()` itself errored at 500 ms, the handler set `onboarding_completed=true` permanently, so the wizard would never appear on relaunch. Fix: wait for the `sidecar-ready` event before building the wizard window. A 30 s timeout fallback opens the window anyway if the event never fires. Build failures no longer flip `onboarding_completed=true`. The dashboard window has used this `sidecar-ready` pattern via bundled `splash.html` since v0.8.1; the wizard now matches.
- **External-discovery branch now emits `sidecar-ready`.** Without this, users running an external `clauge-server` (npx-clauge developer scenario) would only hit the 30 s wizard timeout fallback. The SpawnAt branch already emitted it via `sidecar.rs`; External branch in `lib.rs::run::setup` now does too.
- **Launch-at-login actually works on the App Store build (SMAppService).** The shared autostart plugin uses a `LaunchAgent` plist, which under the App Sandbox is redirected into the app container where launchd never scans it — so launch-at-login silently failed on MAS and the wizard's "added to your login items" line was false. The MAS build now registers via Apple's modern, sandbox-correct `SMAppService.mainApp`, so Clauge genuinely appears in System Settings → Login Items and is user-toggleable (verified via `sfltool dumpbtm`: a `Type: app`, `[sandboxed]`, enabled item). Guarded by a runtime macOS-13 check (SMAppService's floor); on macOS 12 launch-at-login is simply unavailable and the rest of the app is unaffected, so `minimumSystemVersion` stays at 12.0. DMG/Windows keep the existing LaunchAgent path unchanged.

### Added (Mac App Store flavor)

This is the v0.9.0 work, rebased. None of it is wired in the DMG flavor — every change is gated by `#[cfg(feature = "mas")]` on the Rust side and `body.is-flavor-mas` (driven by the `is_mas_flavor` IPC) on the frontend.

- **Sandboxed Mac App Store flavor.** App Sandbox with security-scoped bookmark for read-only access to `~/.claude/`. Wizard step 2 swaps macOS Keychain prompt copy for "Grant access to your Claude Code logs" with an NSOpenPanel folder picker. Wizard step 5 swaps Keychain Connect copy for bookmark-read copy.
- **Settings → Connections gets a 4th row.** Surfaces Claude Code logs grant state (granted / not granted) with a "Re-select folder" button. Only renders when `body.is-flavor-mas`.
- **Settings → Updates routes to the App Store.** On MAS the "Check Now" button relabels to "Get latest version on the App Store" and opens `macappstore://apps.apple.com/app/clauge/id6770303247` — Apple's policy forbids in-app self-updates. The Restart Now button is hidden (no in-app install to restart into). DMG/NSIS keep the existing latest.json poll + xattr-strip path.
- **Sandbox-safe `kill_pid_on_port` on macOS.** Replaces the `lsof -i :PORT -t` + `kill -9` shell-out (blocked by App Sandbox; would silently no-op on MAS and leave orphan sidecars on port 3456) with an in-process libproc walk: `pids_by_type(All)` → `listpidinfo::<ListFDs>` → `pidfdinfo::<SocketFDInfo>` → `libc::kill(pid, SIGKILL)`. DMG users on macOS also benefit (no subprocess spawn cost). Other Unix (Linux, BSD) keeps the legacy lsof path.
- **Three new IPCs.** `is_mas_flavor`, `grant_claude_dir_access`, `has_claude_dir_bookmark`. Registered on both flavors so the frontend can probe shape without branching on a build-time constant.
- **`keychain.rs` flavor-split.** MAS variant tries `~/.claude/.credentials.json` first (via the bookmark), falls back to Keychain Services. DMG variant is Keychain-only as before. The Mac CLI doesn't write the filesystem mirror, so MAS users land on the Keychain fallback in practice and click "Always Allow" once.
- **`claude_ai_session` module cfg-gated out on MAS.** The direct webview-cookie flow would trigger a Keychain prompt every 30 s polling cycle on MAS (sandbox identity doesn't inherit the ACL the non-sandboxed CLI wrote). The Clauge Sync browser extension is the recommended path on MAS, surfaced via wizard step 4.

### Engineering

- **New `AGENTS.md` landmine #24** — MAS-flavor sidecar binaries MUST be wrapped in their own `.app` bundle inside `Contents/Helpers/`, and the helper's `com.apple.security.inherit=true` is load-bearing (without it the helper SIGTRAPs in `_libsecinit_appsandbox.cold.9`). Documents the inside-out signing order and the first-spawn-after-entitlement-change transient.
- **New `AGENTS.md` landmine #25** — when the MAS spawn path bypasses Tauri's shell plugin (`tokio::process::Command` instead of `app.shell().sidecar(...)`), env vars do NOT auto-inherit the way the shell plugin arranges; read `MAS_CLAUDE_DIR.get()` at spawn time and forward it as `CLAUDE_DIR` explicitly. Lists the other sidecar env vars (`CLAUDE_PROJECTS_DIR`, `CLAUDE_CONFIG_DIR`) to mind.
- **`AGENTS.md` landmine #23** (added earlier) — the wizard `sidecar-ready` rule, retained as defense-in-depth: any `WebviewWindow` that loads from `http://127.0.0.1:PORT/...` (sidecar HTTP origin) MUST gate its `build()` on a `sidecar-ready` event listener, not a fixed `tokio::sleep`.
- **`AGENT_LEARNINGS.md` entry corrected** — the original 2026-05-28 entry framed v0.9.10 as the wizard-race fix; the 2026-05-29 entry recontextualizes it: the load-bearing 2.1(a) fix was the sandbox-boot architecture (helper.app + inherit) plus the `CLAUDE_DIR` env-forward. The wizard race entry is preserved as a point-in-time observation.
- **`bundleVersion` bumped 3 → 4** in `tauri.mas.conf.json` (CFBundleVersion must monotonically increase per Apple's submission rules; build 3 was rejected, so the next upload is build 4).

## [0.9.9] — 2026-05-27

**Polish release.** Removes the 60-second flicker on the dashboard's plan card. The flicker was a long-standing visual issue (present since v0.9.4 when the auto-refresh interval was wired) — easy to miss as "slight" or "the dashboard breathing," but it was a real per-minute repaint of the plan-hero area and surrounding text. v0.9.8 didn't introduce it; this release just fixes it.

### Fixed

- **Plan card no longer flickers every 60 seconds.** Root cause: the auto-refresh interval re-rendered `#plan-meta` via `innerHTML` assignment every minute, which destroyed and recreated `<span class="dot-live">` (the green sync-status dot). The dot's CSS `@keyframes pulse` animation restarted from frame 0 each tick — visible as a faint brightness snap on the green dot. Same path also rebuilt `#plan-body` (4 SVG rings), `#plan-inline` (19 children in the topbar), and reassigned identical text to 7 finance-side spans every refresh — 38 DOM mutations per minute, most of them noops.
- **Surgical update split.** `renderPlanCapacity` + `renderFinanceSide` now run in two phases: a structural `innerHTML` build that only fires on shape transitions (placeholder ↔ ingested, balance line appearing/disappearing), and a surgical in-place update path for every other 60s tick. Two new helpers — `setTextIfChanged` and `setAttrIfChanged` — guard writes so identical values are no-ops; `setTextIfChanged` prefers `Text.data` assignment on existing single-text-node children so updates fire `characterData` mutations, not `childList` (which is what was restarting the pulse animation). The `.dot-live` element is now preserved across refreshes — its pulse animation runs continuously instead of resetting every minute.

Verified against a fresh sidecar with `MutationObserver` across three consecutive 60s ticks: 6–7 mutations per tick (all legitimate `characterData` updates on relative-time text like "synced N ago"), zero `childList` mutations on plan-body / plan-meta / plan-inline / plan-status-tag, `.dot-live` element identity preserved.

If you're on v0.9.8 and want the fix: `brew upgrade --cask clauge`, or wait ~1 minute for the in-app auto-updater (or download the DMG from the v0.9.9 GitHub Release page).

### Engineering

- **New `AGENTS.md` landmine #21** — codifies the v0.9.8 → v0.9.8-cargo-lock-followup lesson. Version bumps now have an explicit checklist of 4 files (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.lock`'s `clauge` entry). The `check` workflow uses `cargo test` (no `--locked`); the `Release` workflow uses `cargo test --locked` and refuses to proceed if Cargo.lock would need updating. Verify locally before tagging with `cargo check --locked --manifest-path src-tauri/Cargo.toml`.
- **`AGENT_LEARNINGS.md` entry added** — documents the plan-card flicker root cause + the generalizable lesson: any auto-refresh path that rebuilds via `innerHTML` will restart CSS animations on the destroyed children. Split structural and surgical updates when the parent contains a long-lived animated element.

## [0.9.8] — 2026-05-26

**Hotfix + prevention release.** v0.9.7 shipped with a dashboard regression: the Activity heatmap card rendered its header and footer but the heatmap grid itself stayed blank, and the heatmap-stats line kept its `—` placeholder instead of showing active-day counts. Same class of bug as the v0.9.5 → v0.9.6 splash regression — different facade.

### Fixed

- **Dashboard activity heatmap now renders.** Root cause: `popover/heatmap.js` is loaded by both the popover (`popover/index.html`) and the dashboard (`public/index.html`). Its `defaultTooltip()` calls `t('heatmap.tooltipSessions', …)` from the shared copy registry per non-empty cell. The popover's HTML already loaded `<script src="lib/copy.js">` (which defines `window.t`); the dashboard's HTML never did. On the first non-empty cell, `defaultTooltip()` threw `ReferenceError: t is not defined` and aborted render — the heatmap area stayed empty and `#heatmap-stats` kept its `—` placeholder. Fix: load `/popover/lib/copy.js` in `public/index.html` before `heatmap.js`. Popover was unaffected (its `index.html` already loaded `lib/copy.js`).
- **Copy registry now fetches by absolute path.** Secondary cause: `popover/lib/copy.js` fetched the registry with `fetch('copy.json', …)` — a relative URL. From `/popover/index.html` that resolved correctly to `/popover/copy.json`; from `/index.html` it would have 404'd. Switched to `fetch('/popover/copy.json', …)` so the same shared script works from any loading page on the sidecar.

If you're on v0.9.7 and seeing a blank dashboard heatmap: `brew upgrade --cask clauge` will pull v0.9.8, or wait ~1 minute for the in-app auto-updater (or download the DMG from the v0.9.8 GitHub Release page).

### Engineering

- **Facade validator extended to a second facade.** `scripts/validate-html-facade-loads.cjs` (introduced v0.9.7 for `ClaugeBridge`) refactored to a `FACADES` array at the top of the script. Now also enforces the `t()` / `lib/copy.js` rule: any HTML loading a JS file that calls `t('some.key.path', …)` must also load `lib/copy.js` BEFORE it. Adding a future facade is a one-row addition.
- **Validator test coverage** — two new cases in `test/validators.test.js` mirror the existing ClaugeBridge pattern: failing when HTML loads a t()-using JS without `lib/copy.js`, failing when `lib/copy.js` is loaded AFTER. 11 validator tests total now.
- **`AGENTS.md` landmine #20 expanded to a two-row facade table.** Cross-references both incidents (v0.9.5 → v0.9.6 for `ClaugeBridge`, v0.9.7 → v0.9.8 for `t()`).
- **`AGENT_LEARNINGS.md` entry added** documenting the second incident, the same-class-different-facade pattern, and the "narrow guardrails miss the next instance of their own shape" meta-lesson (also promoted to the global rulebook).

## [0.9.7] — 2026-05-26

Polish release. Closes out the v0.9.5 → v0.9.6 hotfix incident with mechanical guardrails so the same class of bug — an HTML page loading a JS file that depends on a centralized facade, but never loading the facade script itself — can't ship again. Plus a small dashboard vibrancy tweak so the wallpaper doesn't bleed through quite as much at full-window scale.

### Changed

- **Dashboard background more opaque** — popover and dashboard previously shared the same 0.55–0.60 alpha vibrancy wash. That ratio reads as elegant tinting on the 340 px popover but feels too see-through across the full dashboard window, where empty space (e.g. the Projects tab with only a few rows) lets the wallpaper bleed through prominently. Bumped to 0.80–0.88 on the dashboard only. Popover wash unchanged.

### Fixed

- **Dashboard vibrancy no longer flickers when the window loses focus.** Previously the dashboard's `NSVisualEffectState::FollowsWindowActiveState` dimmed the vibrancy material when the dashboard wasn't the foreground window. Each focus-change caused a visible brightness flicker. Switched to `NSVisualEffectState::Active` (matching the popover) — vibrancy now stays at full intensity regardless of focus.

### Engineering

- **New validator** `scripts/validate-html-facade-loads.cjs` — wired into `npm run check`. Scans every HTML page in `popover/` and `public/` (the build mirror `public/popover/` is excluded), maps each `<script src>` to its on-disk JS file, and asserts: if any loaded JS contains `\bClaugeBridge\b`, the HTML must also load a script whose file defines `window.ClaugeBridge = ...` BEFORE it. Catches the v0.9.5 regression at lint time. The bridge-defining file and facade-using files are detected by content scan (regex) — no hand-maintained list.
- **Validator test coverage** — three new cases in `test/validators.test.js`: passing against the live tree, failing when an HTML loads facade-using JS without the bridge, failing when the bridge is loaded AFTER the facade-using JS. Mirrors the existing validator-test pattern (passing + intentionally-failing fixtures).
- **`AGENTS.md` landmine #20** — codifies the rule for human contributors. Cross-references the v0.9.5 → v0.9.6 incident and the new validator.

## [0.9.6] — 2026-05-26

**Hotfix release.** v0.9.5 shipped a regression where the dashboard splash screen never advanced past "Starting Clauge…" and showed "Failed to start Clauge / The local server didn't respond within 30 seconds" after 30s. The local server was actually running fine — the splash just couldn't detect it.

### Fixed

- **Dashboard splash now loads correctly.** Root cause: v0.9.5 migrated `popover/splash.js` to use the `window.ClaugeBridge.*` IPC facade, but `popover/splash.html` only loaded `splash.js` — not `lib/tauri-bridge.js`. So `ClaugeBridge` was undefined when `splash.js` ran, both the eager port-check and the polling fallback exited early, and the splash hit its 30s timeout. Fix is one line in `splash.html`: load `lib/tauri-bridge.js` before `splash.js`. Menubar popover was not affected (its `index.html` already loaded the bridge correctly).

If you're on v0.9.5 and seeing the splash error: `brew upgrade --cask clauge` will pull v0.9.6, or wait ~1 minute for the in-app auto-updater to detect it (or download the DMG from the v0.9.6 GitHub Release page).

## [0.9.5] — 2026-05-26

Cleanup + polish release. One user-visible change in the popover: the activity heatmap now shows day-of-week and month axis labels, and all cells render at uniform sizes (previously the columns under "Jan" / "Feb" / "May" / etc. were silently wider because of HTML table auto-layout). Otherwise the release is engineering hygiene — committing the v0.9.4 landmines that documented the popover transparency stack + Windows Rust portability + workflow shell gotchas, routing scattered Tauri IPC calls through a centralized facade, and routing popover strings through a shared registry so future translations and copy edits become single-file edits.

### Changed

- **Popover activity heatmap now has visible axis labels.** Mon / Wed / Fri row labels on the left, abbreviated month labels (Jan / Feb / Mar / Apr / May / etc.) on top. Cells render at 9 px instead of the previous auto-fit ~11 px to make room for the labels while still filling the popover width. Same 180-day range, same data, same color ramp — just a cleaner read.

### Fixed

- **Heatmap cells now visually uniform across columns.** Previously, columns under month labels ("Jan", "May", etc.) were silently wider than other columns because HTML's default auto table-layout grew the column to fit the 3-character label. Cells in those columns appeared chunkier than the rest, which a careful eye could read as data inconsistency. Fixed via `table-layout: fixed` + explicit width clamp on the month-label `<th>` — labels still display, they just overflow their column's right edge instead of expanding it.

### Engineering

- **`AGENTS.md` landmines.** Updated #11 to document the v0.9.4 4-property WKWebView transparency stack (NSPopover default chrome is opaque dark — the `NSVisualEffectView(HudWindow)` wrap + 4 WKWebView property mutations make the vibrancy work, and dropping any one breaks the effect). New #17 (Windows Rust portability — `std::os::unix` gating pattern + per-platform `#[tauri::command]` shape), #18 (`cargo tauri dev` quirks: `on_navigation` 1430 allowance + sidecar binary refresh after `npm run build:sidecar`), #19 (GitHub Actions workflow steps using bash syntax MUST declare `shell: bash` because `windows-2022` runners default to PowerShell).
- **ClaugeBridge migration partial.** Raw `window.__TAURI__.core.invoke(...)` callsites migrated to the centralized `window.ClaugeBridge.*` facade (introduced in v0.9.4) in `public/connections.js`, `public/app.js`, and `popover/splash.js` — 20 callsites total, plus removed the orphaned `getTauriInvoke()` helper. `public/onboarding/onboarding.js` intentionally stays on the old shape — it's fully rewritten in the v0.10.0 onboarding redesign so a v0.9.5 migration would be wasted churn.
- **Copy registry migration partial.** User-facing strings in `popover/popover.js` (49 sites + 10 new dictionary keys covering common dashes / disabled-reason enum / stats disclaimer / sub-headers) and `popover/heatmap.js` (5 sites: tooltip templates + aria-label fallback) now route through the shared `popover/copy.json` registry via `t('key.path', { params })`. Future copy edits + i18n become single-file changes.
- **`/api/activity`** accepts `period=120d` in addition to existing `180d` / `365d` / `all` (added during smoke-test iteration; the final popover renders `180d`). New integration test under `test/server-activity.test.js`.

## [0.9.4] — 2026-05-26

The biggest user-visible release since v0.9.1: an **activity heatmap** on both the dashboard and popover, **opaque vibrancy** on both surfaces (wallpaper hue tints faintly through HudWindow material — see screenshots), a **bundled `clauge` CLI** at a stable path inside the .app bundle, and a "**Temporarily gated by Anthropic**" dashboard regression fixed. Plus a quiet engineering layer: SECURITY + CONTRIBUTING docs, four `npm run check` validators that catch architectural drift at lint time, a release-pipeline version-sync gate, and groundwork for i18n (copy registry) and IPC consolidation (single Tauri bridge facade).

### Added

- **Activity heatmap.** GitHub-style grid of daily usage intensity. Dashboard variant has a `180d / 365d / All` range dropdown; popover shows a compact 180-day grid below the spend chart. Stats line: "N active days · M-day current streak · longest L". Single orange ramp on both surfaces. Built on `lib/activity.js` (pure quartile bucketing + streak helpers, with full unit-test coverage) and `GET /api/activity`.
- **Dashboard button in the popover footer.** ⌘D from the popover (or click the button) opens the full dashboard. Added in front of "About Clauge" to bring back one-click access after the v0.9.4 popover streamlining removed the Usage Dashboard action.
- **Bundled `clauge` CLI** inside the .app. After a DMG install, the CLI is callable at:
  ```bash
  /Applications/Clauge.app/Contents/Resources/clauge-cli config get
  ```
  To put it on `PATH`, symlink once:
  ```bash
  sudo ln -s "/Applications/Clauge.app/Contents/Resources/clauge-cli" /usr/local/bin/clauge
  ```
  A new `install_cli_symlink` Tauri IPC wires this up for a future one-click wizard step (v0.9.5). Homebrew installs already place `clauge` on `PATH`.
- **SECURITY.md and CONTRIBUTING.md** at repo root, linked from README. SECURITY enumerates the Keychain / OAuth blob / local-HTTP / Tauri webview surface (in-scope vs out-of-scope) and a 48h-ack / 14d-fix target for high-severity reports. CONTRIBUTING covers Conventional Commits, `npm run check`, where issues go, and a 48h-response soft SLA.

### Changed

- **Opaque vibrancy treatment on both surfaces.** Dashboard window now uses `.transparent(true)` + `apply_vibrancy(HudWindow, FollowsWindowActiveState, 14.0)` on macOS, with `apply_mica`/`apply_acrylic` fallback on Windows. Popover wraps its WKWebView in an `NSVisualEffectView(HudWindow)` so it matches. Both surfaces composite the same CSS wash (`rgba(30,26,38,0.55)` → `rgba(20,18,26,0.60)`, `blur(80px) saturate(180%)`, brand-orange sheen top-left) onto the OS material — wallpaper hue bleeds through, text stays legible.
- **Popover surface streamlined.** Five items retired to make room for the heatmap: **Add Account**, **Usage Dashboard**, **Status row**, **Refresh button** (`⌘R`), **Settings button** (`⌘,`). Auto-refresh runs every 10s so the manual Refresh became redundant; Settings is still reachable via tray right-click → Preferences. ⌘D still opens the dashboard, and a new explicit "Dashboard" button surfaces it in the footer.

### Fixed

- **Dashboard "EXTRA USAGE" card no longer reads `$— · Temporarily gated by Anthropic` when the data is actually present.** Previously the dashboard only consumed `plan.extraUsage` (OAuth-API per-org spend, which Anthropic has been gating at the org level for many users since 2026-05). The popover already preferred `plan.consumerOverage` (the claude.ai `/overage_spend_limit` row — the usage credits you see at claude.ai/settings/usage); the dashboard now applies the same preference. Over-cap readings like `196%` are now visible in the label.

### Engineering

- **`AGENTS.md` "Load-bearing conventions (data contract)"** section. Five invariants the cost math depends on: JSONL turns deduped by `requestId`, `ephemeral_5m` vs `ephemeral_1h` cache-tier split, never reading `costUSD` from JSONL, never computing cost from `total_tokens`, and the canonical aggregator field-shape. Cross-referenced from `lib/parser.js`.
- **`AGENTS.md` landmines #15 + #16** documenting the heatmap data path (lib/activity.js → /api/activity → popover/heatmap.js shared renderer) and the in-progress copy-registry + Tauri-bridge migration shape.
- **Four architecture validators in `npm run check`:**
  - `validate-ipc-triple-register.cjs` — every `#[tauri::command]` is in `generate_handler![]` + `APP_COMMANDS` + `capabilities/main.json` (catches landmine #1 at lint time).
  - `validate-no-console-log.cjs` — no `console.log` in `lib/` + `popover/`.
  - `validate-no-hardcoded-port.cjs` — no `:3456..:3460` URL literals in `popover/`.
  - `validate-copy-registry.cjs` — every `t('key')` call resolves to `popover/copy.json`.
  Each has a passing + intentionally-failing test fixture under `test/validators.test.js`.
- **Release-pipeline version-sync** step in `release.yml`. Asserts `package.json` + `tauri.conf.json` + `Cargo.toml` + the pushed tag all carry the same version before any build work runs.
- **Copy registry infrastructure** at `popover/copy.json` + `popover/lib/copy.js`. 61 keys covering the popover string surface; `window.t('key.path', { params })` lookup with `{placeholder}` substitution. Validator catches typos. String migration of existing inline strings is incremental — the registry is wired and ready for new strings now.
- **Tauri ↔ Web bridge infrastructure** at `popover/lib/tauri-bridge.js`. `window.ClaugeBridge` exposes one method per Tauri command — enumerates the entire IPC surface in one file for trivial audit. Loaded on dashboard, popover, and onboarding wizard. Migration of existing `__TAURI__.core.invoke(...)` callsites is incremental.

## [0.9.3] — 2026-05-25

### Added

- **Companion CLI** (`clauge config`). Six subcommands plus `--help` / `--version`:
  - `clauge config get` — print Clauge config as JSON. HTTP-first (talks to a running Clauge via the new port-file mechanism), disk-fallback when offline.
  - `clauge config providers` — list providers + enabled state. Tabular by default, `--json` for machines.
  - `clauge config enable --provider <name>` / `disable --provider <name>` — toggle a provider on/off. Routes through the running Clauge's HTTP endpoint when available; writes directly to `settings.json` when not.
  - `clauge config set-api-key --provider anthropic-admin --stdin` — store an admin API key in macOS Keychain (forward-looking — consumed by v0.10.0 IAP). Rejects keys passed on argv; **only** reads from stdin to avoid shell-history leaks.
  - `clauge config reset-trial [--yes]` — wipe the trial-counter Keychain item. Three locks: macOS-only platform gate, dev-mode gate (`CLAUGE_DEV=1` OR `settings.json.dev_mode: true`), and a confirmation prompt unless `--yes` is passed.
- **Port-file mechanism** — Tauri shell now writes `~/Library/Caches/Clauge/active-port` from `AppState::set_port` (atomic write via tmp + rename) and removes it on graceful shutdown. Enables the CLI to find a running Clauge over HTTP without any IPC handshake.

### Notes

- `set-api-key` and `reset-trial` are **macOS-only** in v0.9.3 — they shell out to the `security` CLI. Windows + Linux Keychain support tracked for v0.9.4.
- The forward-looking Keychain items (`com.clauding.clauge.trial-counter`, `com.clauding.clauge.anthropic-admin-key`) are written by the CLI but not yet read by any Clauge code path. They become live in v0.10.0 IAP work.
- Known race documented in `AGENTS.md` landmine #14: concurrent writes to `settings.json` by the JS sidecar (CLI path) and the Tauri plugin_store (dashboard path) can clobber each other in a small window. Real-world trigger is implausible; proper fix (Rust IPC bridge) deferred to v0.9.4.

## [0.9.2] — 2026-05-23

### Changed

- **Popover now dismisses on outside click**, matching the macOS menu-bar convention every other menu-bar app uses (system Wi-Fi / Battery popovers, CodexBar, etc.). `NSPopover` behavior swapped from `.ApplicationDefined` (sticky — only the tray icon dismissed) to `.Transient`. v0.7.x through v0.9.1 used the sticky behavior; reverted now that the v3 foundation has stabilised and users coming from other menu-bar apps were finding the sticky popover surprising.

### Distribution

- **Homebrew install path now stable** (shipped in v0.9.1, called out here for visibility):
  ```bash
  brew install --cask clauding-lab/tap/clauge
  ```
  Tap repo: [clauding-lab/homebrew-tap](https://github.com/clauding-lab/homebrew-tap). The cask auto-bumps on every `v*` tag release — no manual updates needed once installed (`brew upgrade clauge` pulls the latest).

## [0.9.1] — 2026-05-22

### Added

- **Redesigned popover** — CodexBar-inspired vertical layout with paired circle gauges for Session + Weekly at the top, side-by-side. Each circle has a dual indicator: orange fill = resource used, plus an external white triangle marker on the rim = time elapsed in the window. When usage outpaces time by >10pp, the over-burn arc tints muted red. Vibrancy material lets the wallpaper bleed through.
- **New weekly windows from Anthropic's OAuth `/api/oauth/usage` endpoint** — Sonnet only, Claude Design (Anthropic codename "omelette"), and Daily Routines (codename "cowork"). Each parsed via a multi-key fallback in `src-tauri/src/anthropic_oauth.rs` so renames between codename and public name don't break the popover. Daily Routines renders as "N of 15 runs today" (count, not %).
- **Extra usage (MTD) shows real claude.ai consumer credits** — the `$X spent / $Y monthly limit · N% used` numbers visible at claude.ai/settings/usage. Fetched by Clauge Sync v0.2.0 from `https://claude.ai/api/organizations/{uuid}/overage_spend_limit` (endpoint discovered via CodexBar). Past 100%, the bar reproportions to show a red overage segment. Balance + Auto-reload sub-line carries claude.ai's prepaid balance + setting.
- **Daily spend mini-chart in the popover** — 30 vertical bars showing per-day spend over the last month, today highlighted. Pulls from `/api/daily?period=30d`.
- **2-column stats grid** — today vs. last 30 days, each with cost (big) + tokens (smaller).
- **Status: All systems normal action item** + Homebrew install option: `brew install --cask clauding-lab/tap/clauge`.
- **AGENTS.md + VISION.md** at the repo root — governance docs for AI coding agents (Claude Code, Cursor, Codex CLI). AGENTS.md codifies build/test/release commands, repo structure, and 10 landmines (Tauri IPC triple-registration, SEA manifest mirror, platform-specific webview URLs, etc.) that were previously trapped in Claude's auto-memory only. VISION.md scopes what auto-merges vs. needs sign-off.

### Changed

- **Popover background** is now translucent cool-slate (`rgba(26,24,32,0.22)` over WKWebView `setUnderPageBackgroundColor: clear`), matching CodexBar's see-through vibrancy feel.
- **Popover width** 360px → 340px to match the spacious vertical rhythm.
- **All times displayed in human-relative form** (e.g., "1h 24m of 5h", "Day 5 of 7", "resets in 4h 9m") with compact two-line meta under each hero gauge.

### Internal

- **`npm run check` quality gate** — single command runs `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, and `npm test`. Wired into `.github/workflows/check.yml` (push to main + every PR).
- **11 pre-existing clippy warnings fixed** as a precursor to enabling strict-mode lint. Two trivial auto-fixes (let_and_return, unneeded return), 4 doc-list formatting tweaks, 3 `#[allow(deprecated)]` annotations with TODOs for the pending `tauri-plugin-opener` migration, 2 `#[allow(dead_code)]` annotations on future-use functions, 1 `#[allow(clippy::enum_variant_names)]` on `CrashAction` (the `Respawn` suffix is intentional).
- **OAuth schema-drift detection** — `PlanUsage::unknown_seven_day_keys()` and `normalizeUsage`'s `unknownSevenDayKeys` field surface any `seven_day_*` keys returned by Anthropic that Clauge doesn't recognize. Logged so future Anthropic renames are visible before users notice silent breakage.
- **`docs/superpowers/plans/2026-05-22-codexbar-adoption-plan.md`** — 3-phase plan for selectively adopting CodexBar patterns. Phase A (governance + quality gate + Homebrew tap + release-env docs) and Phase B (popover redesign + new fields + Sparkle audit) ship in v0.9.1. Phase C (companion CLI) deferred to v0.9.2.
- **`docs/updater-ux-audit.md`** — paper audit comparing Clauge's `tauri-plugin-updater` UX to CodexBar's Sparkle. Documents 4 follow-up items (release-notes screen, update-on-consent flow, failure modal, skip-this-version) deferred from v0.9.1.
- **`.mac-release.env.example`** + RELEASE_CHECKLIST.md "Release identifier locations" section — single source of truth for release-time secrets and IDs.
- **Companion repo** `clauding-lab/homebrew-tap` created with `Casks/clauge.rb` + an auto-update workflow that bumps the cask on every `v*` tag release.

### Requires

- **Clauge Sync browser extension v0.2.0+** to surface claude.ai consumer overage data (the `$X / $Y monthly limit · N% used` row). Older Sync versions still work — Clauge gracefully falls back to OAuth-API `extraUsage` when the new field is absent. CWS submission is a separate workflow; see `docs/CWS_LISTING.md`.

## [0.8.2] — 2026-05-16

### Changed

- **EXTRA USAGE card now surfaces Anthropic's gating reason instead of "not configured".** When claude.ai's `/usage` API returns `extra_usage.is_enabled: false` with a `disabled_reason` (e.g. `org_level_disabled_until`), the dashboard now shows "Temporarily gated by Anthropic" with a neutral gray bar and `—` value, instead of the misleading `$0.00 / not configured`. Helps users distinguish "I haven't set this up" from "Anthropic is currently blocking the feature for my org." Unknown `disabled_reason` enum values fall back to a generic "Disabled by Anthropic" message.

### Internal

- Parser at `lib/usage-store.js::normalizeUsage` propagates `extra_usage.disabled_reason` as `extraUsage.disabledReason` (camelCased) for the renderer.
- Three new unit tests in `test/usage-store.test.js` cover the new field's propagation.

## [0.8.1] — 2026-05-16

### Added

- **Splash screen on first launch.** Replaces the WebView2 "page not loaded, please refresh" flash on Windows cold-launch (sidecar takes ~2-4s to bind first time). Branded Clauge logo + spinner appears within ~100ms; transitions to dashboard once `/api/health` responds. Less visible on Mac (sidecar boots in ~200-500ms) but provides consistent UX.
- **First-launch wizard step "Install Clauge Sync".** New step 4 (between Permissions and Connect) walks Windows users through installing the Clauge Sync browser extension from the Chrome Web Store (also installable in Edge). Wizard auto-advances once the extension's first heartbeat arrives.
- **Wizard Connect lands on Settings → Connections.** After a successful credential read, the dashboard switches to the Connections panel so users immediately see their freshly-detected state. Skip stays on Overview.

### Changed

- **claude.ai row UX de-alarmed when Clauge Sync is providing data.** Windows: row hidden entirely (sign-in is deferred). Mac: when extension is active and user is not signed in to claude.ai, the row shows a neutral gray dot + "Optional — plan data is flowing via Clauge Sync" instead of the alarm-colored "not connected" state.

### Fixed

- **Font 404s on dashboard.** `inter-latin-variable.woff2` and `jetbrains-mono-latin-variable.woff2` are now bundled in the SEA manifest at `public/fonts/`, matching how `public/styles.css` requests them. Browsers no longer fall back to system fonts.

### Internal

- `port_discovery::probe` now delegates to `probe_with_body(port).is_some()`, removing the duplicated probe body and silencing a `dead_code` warning.

## 0.8.0 (2026-05-XX) — Windows port

**First Windows release.** Clauge now ships as an NSIS installer alongside the existing macOS DMG. Same codebase, same auto-updater channel — your existing v0.7.3 macOS install gets the v0.8.0 update normally; new Windows users download `Clauge_0.8.0_x64-setup.exe` from the Releases page. Windows users see a Microsoft Defender SmartScreen warning on first launch (Authenticode signing is deferred); README documents the click-through.

### Added

- **Windows x86_64 NSIS installer** with per-user install mode (no UAC admin prompt). Tauri's WebView2 download bootstrapper handles the rare Windows 10 machine without Edge WebView2 pre-installed.
- **Cross-platform `kill_pid_on_port`** (`port_discovery.rs`) — Unix path unchanged; new Windows branch parses `netstat -ano` and `taskkill /F /PID`. Closes the same orphan-sidecar gap on Windows that v0.7.3 closed on macOS.
- **Filesystem credential reader** (`keychain.rs::read_claude_code_credentials` Windows impl) — reads `%USERPROFILE%\.claude\.credentials.json` directly. Schema is identical to the macOS Keychain blob (empirical verification at `docs/superpowers/notes/2026-05-15-windows-claude-code-creds.md`); no struct changes needed.
- **Windows multi-resolution icon** (`src-tauri/icons/icon.ico`, 7 sizes: 16/32/48/64/96/128/256).

### Changed

- **`scripts/build-sidecar.mjs`** (cross-platform Node ESM) replaces the bash + `lipo` `scripts/build-sidecar.sh`. macOS branch reproduces the prior arm64 + x86_64 + universal flow byte-for-functional-equivalent; Windows branch produces `clauge-server-x86_64-pc-windows-msvc.exe`.
- **`tauri.conf.json::build.beforeBuildCommand`** now invokes the .mjs script.
- **CI release workflow** restructured to a build matrix (`macos-14` + `windows-2022`) with a third `mirror-updater` job that merges per-platform `latest.json` files into a unified file served from `gh-pages`. Auto-updater client picks the correct entry per OS/arch.

### Windows-specific UX notes

- **No system-tray icon on Windows** — closing the dashboard window quits the app (Start Menu shortcut relaunches). The macOS menu-bar % chiclet has no Windows equivalent without dynamic-ICO rendering; deferred.
- **First-launch wizard** (v0.7.2 feature) works identically on Windows. No Keychain prompt to explain — the wizard's "macOS keychain" step is benign no-op on Windows.
- **Restart Now button** (v0.7.3 feature) works on Windows via `AppHandle::restart()`.

### Known limitations (Windows)

- **Unsigned binary** — SmartScreen will warn on first launch. Authenticode signing (~$300-500/yr EV cert) deferred until download volume justifies. README has click-through instructions.
- **Architecture A (claude.ai sign-in) not supported on Windows in v0.8.0.** The 3 IPCs degenerate to `NotAuthenticated`. Architecture B (Claude Code CLI keychain → credentials file) is the only path; Anthropic OAuth bearer is read from the file as on macOS. WebView2 cookie-capture port deferred to v0.8.x.
- **x86_64 only** — Surface Pro X / Snapdragon Copilot+ (ARM64 Windows) not supported. Add when there's a user.
- **No MSI bundle** — NSIS only. Add MSI variant if a corporate IT team asks.

### Internal

- `KeychainError` gained an `Io(std::io::Error)` variant for Windows filesystem errors. Mac-side `Framework { code, message }` variant unchanged.
- `port_discovery::kill_pid_on_port` split into `kill_pid_on_port_unix` (`#[cfg(unix)]`) + `kill_pid_on_port_windows` (`#[cfg(windows)]`); 3 new Windows-only tests for file-reader edge cases (NotFound, valid JSON, garbage JSON).
- `macos-private-api` Tauri feature stays on the base `[dependencies]` line — tauri-build's allowlist check rejects the per-target placement attempt. Documented in plan.
- `mod native_popover;` stays unconditional — the module already exposes cross-platform stubs at lines 676-682 for non-macOS callers.

## 0.7.3 (2026-05-15) — Auto-update reliability hotfix

**Two changes to make auto-updates actually take effect across versions.**

### Fixed

- **Orphan sidecar across auto-updates.** When the Tauri auto-updater replaced `/Applications/Clauge.app` on disk, the old `clauge-server` sidecar process kept running on port 3456 across the user's restart. The new Tauri shell's `port_discovery` would find the orphan responding on `/api/health` and use it as the sidecar — serving the OLD `package.json` version. Cold-launch self-heal now version-checks the External-discovery sidecar against the Tauri shell's `CARGO_PKG_VERSION` and `lsof -i :3456 -t` + `kill -9` evicts the orphan on mismatch, then re-runs discovery to spawn a fresh child.
- **No in-app affordance to apply updates.** Settings → Updates → Check Now downloads + installs the new .app, but the only signal to restart was a single macOS notification ("Restart to apply") that's easily missed. New "Restart Now" button surfaces in the same pane after install, with the new version in its label.

### Added

- `restart_app` IPC command (signal_shutdown → kill children → sleep 200 ms → app.restart()).
- `↻ Restart Now to apply vX.Y.Z` button in Settings → Updates, hidden by default and unhidden after `check_for_updates` returns `Installed`.

### Internal

- `port_discovery::version_matches_self` and `kill_pid_on_port` helpers (4 + 1 unit tests).
- `port_discovery::discover` split into `discover` + `discover_with_retry` (single retry on orphan-kill prevents infinite recursion if `lsof` is missing).
- `UpdateStatus::Installed` extended to `Installed { version: String }` (tagged-enum payload).
- v0.7.2 plan Task 17 amended with a "Lessons learned" addendum noting `bash scripts/build-sidecar.sh` requirement for local builds (CI is unaffected via `tauri.conf.json::build.beforeBuildCommand`).

### Known limitations

- Same as v0.7.2: keychain prompt still fires once per app launch (ad-hoc-signing reality), and the claude.ai sessionKey path remains uncached. Both ride v0.8.0.

## 0.7.2 (2026-05-15) — Keychain UX + first-launch wizard + v0.7.x debt cleanup

### Added

- First-launch onboarding wizard (4 steps) explaining the macOS Keychain prompt and setting expectations for ad-hoc-signed builds. Fires on first launch; suppressed thereafter via `onboarding_completed` flag.
- In-memory keychain cache: collapses ~120 keychain reads per hour (from 30s polling) to 1 read per launch. Manual `↻` Refresh button in Settings → Connections triggers a fresh read.
- `refresh_credentials`, `wizard_complete`, `wizard_skip` IPC commands.
- Expired-state amber dot in the Claude Code connection row (was previously collapsed to "Not Installed").

### Fixed

- Architecture A claude.ai login: cookie-capture polling now has a 60s ceiling (40 attempts × 1.5s); past that, the auth window closes and a `cookie-capture-timeout` event fires so the frontend can show "Sign-in didn't complete."
- Popover JS not running on launch (commit `07fca20` from post-v0.7.1; rides v0.7.2).

### Internal

- Errno-based keychain error mapping replaces the brittle `e.to_string().contains(...)` pattern.
- `KEYCHAIN_SERVICE`, `EXTENSION_FRESHNESS_MINUTES`, `LOCAL_HEALTH_TIMEOUT` extracted to module-level consts.
- Shared `reqwest::Client` (`OAUTH_CLIENT`) via `once_cell::sync::Lazy`; replaces three per-call `Client::new()` sites.
- Cache-invalidation contract documented on `fetch_oauth_usage` for v0.8.0 callers.

### Known limitations

- Keychain prompt still fires once per app launch. This is the ad-hoc-signing reality — without an Apple Developer ID signature, macOS Keychain can't durably bind the "Always Allow" ACL. Persistent fix lands in v0.8.0 alongside the Mac App Store flavor (Apple Developer enrollment is on the v0.8.0 plan as Task 12).
- The cache only covers Claude Code credentials. The separate claude.ai sessionKey (used by Architecture A) is still re-read on each connections poll — users with a stored claude.ai cookie will see additional Keychain prompts beyond the once-per-launch Claude Code one. Wrapping the claude.ai cookie in a similar cache rides v0.8.0 alongside the Architecture A data plumbing.

## 0.7.1 (2026-05-14) — UI polish + updater detection fix

**Two small follow-ups from the v0.7.0 release smoke. No new features;
both fixes ride a regular auto-updater push.**

### Fixed
- **Settings → General "Check for Updates" now correctly detects available
  releases.** The v0.7.0 ship had a JS-side bug where `update.available`
  was read from the `plugin:updater|check` response, but tauri-plugin-
  updater 2.10 returns the `Update` object directly (or `null`) with no
  `available` field. The dashboard reported "Up to date" even when a
  newer release was published. v0.7.1 switches to a truthy-on-Update
  check that matches the plugin's actual response shape.

### Changed
- **Removed the session + project count badges from the main tab strip.**
  The "Sessions 1024" / "Projects 8" pill badges added visual noise
  without new information — both panels display their own totals
  prominently. The badge spans + their JS writers are gone; the
  `sessions-count` / `projects-count` elements inside the panels are
  unaffected.

### Note on release numbering
- The v0.7.1 slot was previously reserved for the Mac App Store
  (MAS-flavor) side workstream per the 2026-05-11 release-sequencing
  decision. That workstream renumbers to v0.8.0; its plan document
  (`docs/superpowers/plans/2026-05-11-v0.8.0-mas-plan.md`) and the
  project memory note will be updated as a follow-up commit.

## 0.7.0 (2026-05-14) — Hybrid macOS auth (DMG)

**Adds two new authentication paths in addition to the browser extension —
the Settings → Connections panel composes them into a single live status
snapshot. macOS DMG flavor only; Mac App Store flavor (sandbox + security-
scoped bookmark) is the parallel v0.8.0 side workstream.**

### Architecture B — Claude Code keychain piggyback (NEW)
- Reads the OAuth credentials Claude Code CLI writes to macOS Keychain
  under service name `Claude Code-credentials`.
- First read triggers the standard macOS "always allow" prompt.
- Calls `api.anthropic.com/api/oauth/usage` with the bearer token for plan-
  ring data. PlanUsage parser is permissive (Option<f64> + serde-flatten
  catch-all) so unknown response keys won't break parsing.
- Token leak guard: `Debug` impl on the credentials struct redacts both
  access and refresh tokens.

### Architecture A — claude.ai webview login (auth surface only)
- Opens an in-app WKWebView modal at `https://claude.ai/login`. User signs
  in normally (Google / email / passkey). The `sessionKey` cookie is
  captured via Tauri 2's `WebviewWindow::cookies_for_url` and persisted
  to macOS Keychain under our own service name
  `com.clauding.clauge.claude-ai-session`.
- **Scope note:** v0.7.0 ships the auth surface only. The cookie persists,
  the Connections panel green-dots "Signed in to claude.ai", but no
  dashboard plan-ring data is pulled via this path yet (`fetch_claude_ai_
  usage` is a stub for v0.8.0). Users who rely solely on claude.ai (no
  Claude Code CLI installed) will still see empty plan rings in v0.7.0 —
  the browser extension remains the data path for that cohort.

### Connections panel (NEW)
- Settings → Connections (renamed from "claude.ai sync"). Three independent
  rows: Claude Code CLI · claude.ai web · Browser extension.
- Each row has its own state dot (green / amber / red), live-updating via
  a 30-second IPC poll + `connections-updated` Tauri events + window-focus
  refresh.
- Tauri 2 ACL: 4 new app-level permissions (`allow-get-connection-status`,
  `allow-open-claude-ai-login`, `allow-signout-claude-ai`,
  `allow-has-claude-ai-session`) registered via `tauri_build::AppManifest`.
- `/api/health` now emits `extensionLastSeenAt` so the extension row
  reflects actual sync state instead of always showing "Not detected".

### Connection-related debt deferred to v0.8.0
- Shared timeout-configured `reqwest::Client` across `anthropic_oauth` and
  `claude_ai_session` (TODO markers in place).
- `Expired` state for Claude Code OAuth tokens — currently expired tokens
  collapse to "Not installed" (red dot). Expired state variant + label
  copy already exist; only the compositor needs updating.
- Silent retry loop in Architecture A if `cookies_for_url` returns no
  `sessionKey` — needs a `max_attempts` ceiling + user-visible failure.
- Wiring `fetch_claude_ai_usage` into the dashboard data ingest path so
  Architecture A actually serves plan-ring data.
- Empirical pinning of the `api.anthropic.com/api/oauth/usage` response
  shape (currently parsed permissively; manual smoke verifies).

### Other
- New Cargo deps: `security-framework`, `chrono` (with `serde`+`clock`
  features), `thiserror`, `serial_test` (dev).
- New entitlements file `entitlements.dmg.plist` is now explicitly
  referenced from `tauri.conf.json`. Posture matches Tauri's previously-
  implicit DMG defaults; behavior unchanged.
- `app.js` dropped the v0.4.x `set-sync-status` / `set-last-sync` /
  `set-sync-refresh` references — Connections panel owns that state now.

## 0.4.0 (2026-05-08) — V3: Liquid Glass redesign + popover bug fix

**Major redesign: new popover, full dashboard overhaul, canonical tray
icon. Plus the bulletproof fix for the popover-empty bug that survived
v0.3.1's CORS fix.**

### Popover (300px, warm-dark glass)
- New 5-section layout: Header / Plan capacity (5 mini rings:
  Session/Weekly/Sonnet/Opus/Design) / Finance (Extra usage + Balance cards
  with bars) / Today (Cost eq · Messages · Cache hit) / Footer
  (kbd hints + "Open →").
- Warning-state variant (CSS-only, amber): single big ring + suggestion to drop to haiku. Triggers when `plan.fiveHour.pct >= 85`.
- Visual: warm-dark gradient (`#2a1812 → #0d0805`), brand orange `#d97757`, translucent glass with `backdrop-blur(60px) saturate(180%)`, dual rim-light borders, gradient bleed on the header. Inter UI + JetBrains Mono numerics with `tnum`.

### Dashboard (7-tab Liquid Glass)
- Tabs: Overview · Sessions (count) · Projects (count) · Tools · Models · Settings · About. Morphing brand-orange capsule indicator on tabs + period (`cubic-bezier(.2,.8,.2,1)`).
- Period selector: Today / 7 days / 30 days / Month / All time.
- Overview: Plan capacity hero (5 big rings — Session/Weekly/Sonnet/Opus/Design — + Extra usage + claude.ai balance side cards) → code analytics digest strip (API equivalent, Messages, Sessions, Cache hit, Tokens, Return on sub) → Cost over time + Peak hours charts → By project + By activity tables → Recent sessions teaser.
- Settings tab: General / Pricing & ROI / claude.ai sync sub-panes (read-only mirror of `/api/health` + `/api/usage` for v0.4.0; editable settings deferred and visibly disabled with `aria-readonly`).
- About tab: What it does / Roadmap / Credits.

### Bug fix: popover-empty (T35)
- v0.3.1 fixed CORS at the wire level (response includes `access-control-allow-origin: *`), but the popover STILL rendered empty. Root cause: WKWebView's mixed-content guard. Tauri 2.x's asset protocol routes the popover through `tauri://localhost` (or `https://tauri.localhost`) which WKWebView treats as a Mixed-Content secure context — cross-origin `fetch('http://127.0.0.1:port/api/...')` from such a context is silently dropped before the request leaves the webview.
- Fix: new `proxy_fetch` IPC command that runs the request through Rust's `reqwest` (no fetch layer, no CORS, no mixed-content). Popover JS now calls `invoke('proxy_fetch', { path })` instead of native `fetch()`. Path validation restricts to `/api/*`. Response body is capped at 10 MiB as defense-in-depth.
- Also enabled `tauri = { features = [..., "devtools"] }` so right-click → Inspect Element works in production v0.4.0+. Useful for in-the-field diagnostics; benign for users (no automatic JS exposure of secrets).

### Tray icon (T38)
- Replaced the Pillow-rendered programmatic gauge with a render derived from the canonical `public/clauge-menubar-18px.svg` brand mark. New pipeline (`scripts/render-tray-icon.sh`): flattens SVG colors to black via `sed` (preserve opacities for macOS template tinting), then `sips` renders to 22×22 + 44×44.

### Review fixup (T39, pre-tag)
- **Opus capacity ring restored** — design's 4-ring layout extended to 5 in
  both the popover and dashboard plan-hero so v0.3.x's Session/Weekly/
  Sonnet/Opus/Design parity is preserved for Opus-heavy users.
- **Settings panel honesty** — the General tab's "Show menu bar app"
  toggle and "Default period" select were silent no-ops; they're now
  visibly disabled with `aria-readonly="true"` and a clear "editable
  in v0.4.x" tooltip.
- **Popover OS window dimensions** — inner `300×540` was masking the
  warning-state's CSS-driven 240px width and creating a transparent
  dead zone below content. Tightened to `300×440` and removed the
  warn-state CSS `width: 240px` rule so the OS window matches the
  drawn surface in both states.
- **Self-hosted fonts** — removed `fonts.googleapis.com` and
  `fonts.gstatic.com` references. Inter (variable, latin) and
  JetBrains Mono (variable, latin) now ship as woff2 under
  `popover/fonts/` and `public/fonts/`. Privacy-preserving (no CDN
  beacon), offline-safe, and no cold-start render block.
- **render-tray-icon.sh mktemp leak** — the previous template
  (`mktemp -t clauge-tray-mono).svg`) created a tempfile then a
  separate `.svg` sibling, leaking the original. Now uses
  `mktemp -t clauge-tray-mono.XXXXXX.svg`.
- **Stripped `console.log`** — DevTools now ships in production, so
  diagnostic logs were getting noisy. `console.error` retained for
  in-the-field debugging.

### Tests
- Cargo: 24 (was 22 — added two `proxy_fetch` tests: body-size cap and `PROXY_FETCH_MAX_BYTES` constant pin).
- Node: 109 unchanged.

## 0.2.0 (2026-05-06) — V2: claude.ai integration

**Major addition: claude.ai plan usage tracking via browser extension or bookmarklet.**

### claude.ai integration
- **Clauge Sync** browser extension (Manifest V3) submitted to Chrome Web Store. Polls `claude.ai/api/organizations/{uuid}/usage` every minute (configurable) using the user's authenticated browser cookies, POSTs snapshot to local Clauge.
- **One-click bookmarklet** as a no-extension fallback (drag to bookmarks bar, click while on claude.ai).
- New dashboard card with **5 ring gauges** — Session (5h), All models (7d), Sonnet (7d), Opus (7d), Claude Design — colour-coded by 60/85% thresholds, with reset countdowns.
- **Extra-usage card** showing your billing cap with progress bar.
- Backend endpoints: `POST /api/usage/ingest` (CORS-restricted to claude.ai + extension origins), `GET /api/usage`, `GET /api/bookmarklet`.
- Persists snapshots to `~/.clauge/usage.json` (mode 0600).

### Dashboard polish
- **Headline strip** densified to 8 columns: API equivalent · Messages · Tool calls · Sessions · Subagents · Cache hit · Tokens · Primary model.
- **Token strip** below: Input · Output · Cache read · Cache 5m · Cache 1h · Net cache savings.
- **4 sparkline cards** (vanilla SVG, no deps): daily cost, daily calls, sessions/day, cache-hit-rate trend.
- **Hourly distribution** chart (24-hour UTC bar chart).
- **Breakdown tables** (Daily activity / By project / By activity / By model / Core tools / Shell commands / MCP servers) — every row has a horizontal bar showing share, plus precise counts and cost columns.
- **Sessions table** now shows turn count (Calls column) alongside tokens, hit %, cost.
- **Onboarding panel** when no claude.ai sync has happened — leads with "Install Clauge Sync extension" button + collapsible alternates (developer-mode install, bookmarklet).
- **Dollar values** rounded to whole dollars in the dashboard. CSV/JSON exports keep full precision.

### Backend additions
- New aggregator outputs per-session: `messageCount`, `toolCallCount`, `subagentTurnCount` (Agent/Task tool calls), `byHour` distribution.
- `rollupByProject` now carries through messages, tools, hit rate.
- `rollupByHour`, `rollupByTask` exports.
- New tests for `usage-store`, `bookmarklet`, period filtering, ROI calculation, exporter. **Total 113 tests passing.**

### Branding
- Brand-mark icon (Anthropic-coral meter gauge in dial) shipped in dashboard, README header, GitHub release notes, and as the extension icon.
- Browser favicon (SVG with PNG fallback).

### Distribution
- Chrome Web Store submission package: `docs/PRIVACY.md`, `docs/CWS_LISTING.md`, promo tile (440×280), 2 dashboard screenshots (1280×800).

## 0.1.2 (2026-05-06)

- Brand mark in dashboard nav bumped from 28×28 → 36×36 so it reads in the README screenshot.

## 0.1.1 (2026-05-06)

- Brand icon (meter gauge) shipped as favicon, dashboard nav mark, and README header.

## 0.1.0 (2026-05-06) — V1: Claude Code analytics

Initial V1 implementation per PRD v3.1.

**Library** (`lib/`):
- `parser.js` — JSONL stream reader with mandatory `requestId` deduplication (verified against real `~/.claude/projects/*.jsonl`).
- `cost-calculator.js` — LiteLLM auto-pricing (~/.cache → fetch → bundled fallback), two-tier cache rates, never reads `costUSD`.
- `classifier.js` — 8-category task classification with explicit precedence rules.
- `cache-analyzer.js` — corrected hit-rate + net-savings formulas.
- `tool-analyzer.js` — core tool / shell command / MCP server frequency analysis.
- `aggregator.js` — session / project / day / model rollups.
- `roi-calculator.js` — API replacement value with honest framing.
- `period.js` — period (today/7d/30d/month/all) + project filtering.
- `exporter.js` — CSV / JSON downloads.
- `session-store.js` — mtime-keyed in-memory cache.

**Server** (`server.js`):
- Hono server with all PRD §2.9 endpoints.
- Auto-opens browser on launch, clean SIGINT/SIGTERM shutdown.

**Dashboard** (`public/`):
- Editorial dark theme, intentional hierarchy.
- Period switcher + project filter + CSV/JSON export.

**Tests:** 93 passing across 31 suites.

**Verified live numbers (Adnan's Mac, 7d window, 488 sessions):**
- Total cost $1,363.77 (vs $200 subscription = 581.9% replacement value)
- Cache hit rate 98.24%, net cache savings $8,665
- Model split: 97% Opus 4.7, 3% Haiku 4.5
