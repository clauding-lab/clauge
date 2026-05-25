# Changelog

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
