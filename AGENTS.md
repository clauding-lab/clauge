# AGENTS.md — Clauge

Operational rules for AI coding agents (Claude Code, Cursor, Codex CLI, etc.) working in this repo. Read this in full before making any code change.

## What Clauge is

Clauge = **Claude + Gauge**. A token-analytics + subscription-ROI tracker for Claude Code and claude.ai. Ships as:

- **V3 native app** (Tauri 2) — universal macOS DMG, macOS App Store (MAS) build, Windows NSIS installer. This is the product.
- **V2 npm CLI** — legacy `npx clauge` entry; same `server.js` Hono server runs embedded inside V3 as a Node-SEA sidecar. The npm package is retained but not the primary install path.
- **Clauge Sync** — Chrome extension (`extension/`) that scrapes claude.ai usage and POSTs it to the local server. Optional but recommended.

Owner: solo dev (Adnan, Bangladesh, UTC+6). Vibe-coded — Adnan directs AI agents, does not hand-write code himself. All explanations, summaries, and prose should be in **plain English with technical terms briefly explained**, never assume Adnan reads code.

## Repository structure

```
src-tauri/                  # Tauri 2 native shell (Rust)
  src/
    lib.rs                  # Tauri builder + invoke_handler! macro
    main.rs                 # entry point
    ipc.rs                  # all #[tauri::command] handlers
    tray.rs, menu.rs, windows.rs, native_popover.rs
    sidecar.rs              # SEA sidecar lifecycle (spawn/health/evict)
    anthropic_oauth.rs      # Keychain item "Claude Code-credentials"
    claude_ai_session.rs    # Keychain item "com.clauding.clauge.claude-ai-session"
    keychain.rs, keychain_cache.rs, port_discovery.rs, connections.rs
  build.rs                  # APP_COMMANDS allowlist for tauri-build
  capabilities/main.json    # IPC permission grants per command
  tauri.conf.json           # bundle/signing/updater config
  entitlements.dmg.plist    # macOS entitlements for DMG flavor
server.js                   # Hono server (Node SEA inside V3, or standalone via npm)
lib/                        # server.js modules (aggregator, parsers, routes)
scripts/                    # build-sidecar.mjs, sea-config.json, sea-bootstrap.cjs
public/                     # Dashboard SPA (V2.2)
popover/                    # Menu-bar popover SPA (V3 only)
extension/                  # Chrome MV3 extension "Clauge Sync"
test/                       # node --test suites; e2e/ uses tsx + webdriverio
docs/                       # RELEASE_CHECKLIST.md, PRIVACY.md, CWS_LISTING.md, superpowers/
.github/workflows/release.yml  # tag-driven release pipeline
```

## Build, Test, Run

| Goal | Command |
|---|---|
| **Pre-commit / pre-push quality gate** | `npm run check` — runs fmt + clippy strict + cargo test + npm test |
| Run server only (dev) | `npm run dev` |
| Run native app (dev) | `npm run tauri:dev` |
| Build sidecar (Node SEA) | `npm run build:sidecar` |
| Build native app (release) | `npm run tauri:build` |
| Unit tests (JS only) | `npm run test` |
| SEA smoke test | `npm run test:sea` |
| E2E (Linux/Windows only) | `npm run test:e2e` — **does not work on macOS**, tauri-driver lacks macOS support |
| macOS pre-tag smoke | Manual; see `docs/RELEASE_CHECKLIST.md` |

`npm run check` is the **canonical gate** — same command CI runs on every push/PR via `.github/workflows/check.yml`. Run it locally before any commit you intend to push; failures there will fail CI the same way.

`cargo tauri dev` runs Tauri's own dev loop but **does NOT run npm's prebuild scripts**. The SEA bundle embeds `server.js` + `lib/` + `public/` (which includes `popover/` copied in by build-sidecar). Changes to ANY of those — not just `scripts/build-sidecar.mjs` — require a fresh `npm run build:sidecar` before `cargo tauri dev`. The canonical iteration cycle while developing popover/server code is:

```bash
pkill -f clauge && npm run build:sidecar && npm run tauri:dev
```

## Release flow

Tag-driven. `git tag v0.X.Y && git push origin v0.X.Y` triggers `.github/workflows/release.yml` which:

1. Runs JS unit tests + Rust unit tests gate (across matrix: macOS + Windows).
2. **Extracts the release notes** from `CHANGELOG.md`'s `## [X.Y.Z]` section (added v0.9.2). If the section is missing, the build still ships but logs a CI warning + the GitHub Release body is empty.
3. Builds Universal (arm64 + x86_64) DMG + Windows NSIS with Tauri-keypair-signed updater payloads.
4. Publishes a non-draft GitHub Release with .dmg + .exe + .app.tar.gz + .sig files + body from step 2.
5. Mirrors merged `latest.json` to the `gh-pages` branch — updater endpoint reads from `https://clauding-lab.github.io/clauge/latest.json`.

**Before tagging:** complete the macOS smoke + Windows smoke in `docs/RELEASE_CHECKLIST.md`. **Pre-fill `CHANGELOG.md` with a `## [X.Y.Z] — YYYY-MM-DD` section** — release.yml auto-extracts it for the GitHub Release body. Missing section = empty release page.

**Homebrew tap** (`clauding-lab/homebrew-tap`) **auto-bumps on stable `v*` tag pushes** via the `dispatch-homebrew` job in release.yml, which POSTs `repository_dispatch` (`event_type: clauge-release`) to the tap. The tap's `auto-update.yml` workflow then downloads the new DMG, computes its SHA256, and commits the updated `Casks/clauge.rb` — typically within ~30s of release publication.

**Prereleases skip the dispatch** — the tap only carries the latest stable cask (the `if: !contains(github.ref_name, '-')` guard handles this).

**Required secret in the clauge repo**: `HOMEBREW_TAP_DISPATCH_TOKEN` — a fine-grained PAT scoped to `clauding-lab/homebrew-tap` with **Contents: write** permission. Cross-repo `/dispatches` POST cannot use the default `GITHUB_TOKEN` (it's scoped to the workflow's own repo and 403s on writes to other repos). Set this at: Settings → Secrets and variables → Actions on the clauge repo.

**Manual fallback** (if dispatch fails or for an out-of-band bump):

```bash
gh workflow run auto-update.yml --repo clauding-lab/homebrew-tap -f version=X.Y.Z
```

The tap also runs a daily 04:17 UTC cron as a safety net — even if dispatch and manual trigger are both missed, the cron catches it within 24 hours.

**MAS build:** uses a separate `tauri.mas.conf.json` (lives on the `mas-implement-session` branch, not main). Don't merge or rebase that branch into main without explicit sign-off — it contains signing IDs and provisioning profile paths that are environment-specific.

## Coding style

- **Rust:** `cargo fmt` + `cargo clippy --all-targets --all-features -- -D warnings`. Edition 2021, MSRV 1.77.2.
- **JS/TS:** node:test for unit tests; no lint config committed yet — match existing style. Prefer ESM (`type: "module"`).
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, etc.) with optional scope. Imperative mood. **No `Co-Authored-By: Claude` lines** — attribution is disabled globally; do not re-add.
- **Files:** keep modules focused; ~400 lines typical, 800 max. Split Rust modules when one starts mixing tray + popover + keychain logic.

## Known landmines (read before touching these areas)

### 1. Tauri 2 IPC needs registration in THREE places

Adding a new `#[tauri::command]` requires updating:

1. `src-tauri/src/lib.rs` — register in the `invoke_handler!` macro.
2. `src-tauri/build.rs` — add to the `APP_COMMANDS` allowlist (tauri-build reads this).
3. `src-tauri/capabilities/main.json` — add to the `permissions` array.

Missing any one of the three = silent IPC rejection from JS with no useful error. The browser console may show `Command "foo" not allowed` or just hang.

### 2. SEA sidecar has TWO asset manifests — keep them in sync

The Node SEA (Single Executable Application) bootstrapper has two parallel asset lists:

1. `scripts/sea-config.json` — Node's official SEA manifest.
2. `scripts/sea-bootstrap.cjs` — the `ASSETS` array used at runtime.

Adding a file to `public/` alone yields a silent 404 at runtime. To add a new asset:

1. Drop the file in `public/`.
2. Add the path to **both** sea-config.json AND sea-bootstrap.cjs `ASSETS`.
3. Re-run `npm run build:sidecar`.

`cargo tauri dev` does NOT re-run the sidecar build — manually rebuild when sidecar code/assets change.

### 3. Tauri 2 platform-specific webview URLs

The Tauri webview URL differs by platform:

- **macOS:** `tauri://localhost/`
- **Windows:** `http://tauri.localhost/`

Any `on_navigation` handler, CORS allowlist, or string equality check on the webview origin **must allow both shapes** or Windows webview will fall to `about:blank` with no error.

### 4. Keychain item naming (do not rename)

Two keychain items, both load-bearing:

- `Claude Code-credentials` — Claude Code's own OAuth token, written by Anthropic's CLI. Clauge reads-only.
- `com.clauding.clauge.claude-ai-session` — Clauge's own claude.ai session cookies (written by Clauge Sync extension via the local server).

Renaming either breaks the v0.10.0 grandfather-detection logic (planned for `clauding-lab/iap-paywall` branch).

### 5. macOSPrivateApi must be declared at the base level of Cargo.toml

`tauri-build`'s allowlist check walks `[dependencies]` only — not per-target blocks. The `macos-private-api` feature must be on the base `tauri = { ... }` line, not gated by `cfg(target_os = "macos")`. Tauri's own internal cfg-gates handle the actual macOS-only usage; declaring the feature on non-Apple targets is harmless.

### 6. Subagent dispatches always use Opus

Every `Agent` tool call in this repo uses `model: "opus"` — no exceptions, regardless of task size or skill guidance. Adnan's standing rule.

### 7. Tray icon is currently NOT a template image

`src-tauri/icons/tray-icon.png` is a downscaled colored render of the 1024×1024 app icon. macOS expects template images (flat black-on-transparent) for proper tinting in light/dark menu bars. This is on the backlog (see `docs/RELEASE_CHECKLIST.md` "Known issues"). Don't "fix" it without coordinating — a true monochrome SVG variant needs to be authored first.

### 8. Apple Developer + MAS context

- Team ID: `CY4FK9S7X9`
- Apple Developer account: `adnan_du@yahoo.com` (NOT the primary `adnan.rshd@gmail.com`)
- Account active through 2027-05-17
- App Store ID: `6770303247`
- MAS bundle ID: `com.clauding.clauge`
- Provider short name lives in `tauri.mas.conf.json::providerShortName` (mas-implement-session branch only)

### 9. Prefer focused unit tests over WebView/Tauri E2E for trial, entitlement, and paywall logic

macOS `tauri-driver` is unsupported (see `docs/RELEASE_CHECKLIST.md` "E2E manual gaps" — tauri-driver v2.0.6 supports Linux and Windows only). Live AppKit/menu/popover E2E tests on macOS therefore can't run. For trial accounting (v0.10.0), entitlement state, and paywall logic, write pure-state Rust unit tests against the underlying functions — they cover the same behavior without the flake. Extract pure functions from Tauri commands when needed.

### 10. Sibling async tasks where one is required and another optional

When running two async tasks in parallel (`tokio::join!`, `try_join!`, `JoinSet`) and one is required-to-succeed while the other is best-effort, ensure the optional one's failure cannot silently consume or cancel the required one's error. Prefer sequential awaits, or a drained `JoinSet` that surfaces required failures and explicitly contains optional failures. If you see stack traces mentioning premature cancellation in a parallel task block, audit nearby parallel-task usage.

### 11. Native popover — three deliberate decisions (don't revert without thinking)

In `src-tauri/src/native_popover.rs`:

- **`NSPopoverBehavior::Transient`** (v0.9.2+). Pre-v0.9.2 was `.ApplicationDefined` (sticky — popover never auto-dismissed). Switched to `.Transient` to match macOS menu-bar convention (clicking outside dismisses, like CodexBar / system Wi-Fi / Battery popovers). A future agent might "fix" this back to `.ApplicationDefined` thinking it's more useful — don't.
- **`webview.setUnderPageBackgroundColor: NSColor.clearColor`** (v0.9.1+). Required for the popover's CSS-side `backdrop-filter` translucency to actually show the OS vibrancy layer underneath. Without this, WKWebView paints a system-appropriate opaque color behind the page and the wallpaper-through-popover effect dies.
- **`POPOVER_WIDTH: f64 = 340.0`** + **`MAX_POPOVER_HEIGHT: f64 = 1200.0`** (v0.9.1+). Mirrored in `popover/popover.js::resizeToContent` height clamp (`200..1200`). If you change one bound you MUST change both — otherwise the JS posts a height the Rust handler refuses.

### 12. Consumer overage data has TWO sources — keep them separate

`plan.extraUsage` (OAuth `/api/oauth/usage::extra_usage`) and `plan.consumerOverage` (claude.ai `/api/organizations/{uuid}/overage_spend_limit` via Clauge Sync v0.2.0+) report **different things**:

- `extraUsage` — per-org OAuth-API spend on overage credits. Disabled by default; many users have `enabled: false`.
- `consumerOverage` — claude.ai consumer "Usage credits" (the `$X spent / $Y limit` visible at claude.ai/settings/usage). The one users actually see and care about.

The popover prefers `consumerOverage` when present and falls back to `extraUsage`. Don't merge them — the semantics differ. claude.ai returns values in **cents** (1000 = $10); OAuth returns in **cents** for `monthly_limit` but `pct` is already 0..100.

### 13. Chrome extension dev: the Web Store version overrides local edits

When iterating on `extension/`, the Chrome Web Store-published version (currently Clauge Sync v0.2.0 in review at time of writing) **takes precedence** over file edits in `extension/`. Reloading at `chrome://extensions` does nothing because Chrome runs the published version, not the local folder.

To test local extension changes:

1. Open `chrome://extensions` → toggle "Developer mode" ON (top-right).
2. Click **"Load unpacked"** → select `/Users/adnanrashid/Projects/clauge/extension`.
3. **Disable** the Web Store version (toggle off) so both don't poll claude.ai simultaneously and POST duplicates to `/api/usage/ingest`.
4. After edits, click the ↻ reload icon on the unpacked card (only appears in Developer mode) to pick them up.

For real users: ship updates via the Chrome Web Store. The CWS submission flow is in `docs/CWS_LISTING.md`. Manifest description must be ≤132 chars (verified by upload rejection).

### 14. Companion CLI (v0.9.3) — port-file, settings.json race, macOS-only Keychain ops

`server.js` doubles as the CLI binary. Argv past the script name routes through `lib/cli/index.js`'s dispatcher; bare `node server.js` falls through to the Hono server (legacy npx-clauge entrypoint). If you add a new top-level CLI verb, two places need updates:

1. `lib/cli/index.js::parseArgs` — currently only `config` has a subverb. New verbs without subverbs need the verb itself added to the dispatch switch.
2. New subverb modules live at `lib/cli/<verb>-<subverb>.js` and are loaded by dynamic import. Missing modules print "not yet implemented" and exit 2 — graceful, but ship the module if you intend the verb to work.

**Port-file mechanism (`src-tauri/src/port_file.rs` ↔ `lib/config-paths.js::portFile`):** the Tauri shell writes `~/Library/Caches/Clauge/active-port` from `AppState::set_port` (best-effort — failure logs a warning but doesn't fail the in-memory port set). The shutdown handler removes the file on `RunEvent::ExitRequested`. CLI uses this file to find a running Clauge. **The Rust + JS sides compute the path independently** — both have unit tests asserting the exact path string. If you rename `APP_NAME` or change cache-dir conventions on either side, the other's tests fail loud. Don't relax either test without also updating the other side.

**`CLAUGE_HOME` env override:** both `lib/config-paths.js` and `src-tauri/src/port_file.rs` honor this for test isolation — sandboxes path resolution under a tmpdir. Unset in production. Any new path helper should follow the same convention so tests can sandbox it.

**settings.json race (known, accepted in v0.9.3):** the JS sidecar writes provider toggles directly to `settings.json` (the Tauri plugin_store file). If the Tauri shell has the store loaded in memory and calls `store.save()` AFTER the CLI's write, the providers section can be clobbered. Real-world trigger requires toggling via CLI AND completing the wizard via dashboard at the same moment — implausible but non-zero. Proper fix (Rust IPC bridge for settings writes) deferred to v0.9.4. Until then: don't change wizard-completion code paths to call `store.save()` more aggressively than necessary.

**Keychain item names locked in `lib/config-paths.js::keychainItems`:** four items — two existing (`Claude Code-credentials`, `com.clauding.clauge.claude-ai-session`) and two forward-looking (`com.clauding.clauge.trial-counter`, `com.clauding.clauge.anthropic-admin-key`). The forward-looking pair has no Rust reader yet — they're written by the CLI (`set-api-key`, `reset-trial`) and will be consumed by v0.10.0 IAP code. **Don't rename** any of the four; the JS CLI and the (future) Rust reader must agree on the strings.

**CLI Keychain ops are macOS-only:** `set-api-key` and `reset-trial` shell out to `security`. Other platforms get a clean error with exit 2. Windows + Linux Keychain support (`cmdkey` / libsecret, or a Node native binding like `keytar`) tracked for v0.9.4. `set-api-key` passes the key via `-w <key>` which puts it in `security`'s argv for the spawn — small ps-visibility window. v0.9.4 will swap to `keytar` to close this.

**Test discovery:** `npm test` glob is `test/*.test.js test/cli/*.test.js`. New CLI test files go under `test/cli/`. New non-CLI test files at `test/`. If you add a third directory, update the glob in `package.json` — without that, `npm run check` silently skips your tests.

### 15. Activity heatmap (v0.9.4) — data path + popover removals

**Data path** is the same on both surfaces. Don't fork the renderer:

1. `lib/activity.js` — pure helpers (`computeBuckets`, `countActiveDays`, `computeCurrentStreak`, `computeLongestStreak`, `summarizeActivity`, `aggregateDailyActivity`). All side-effect-free, all testable. `today` is always passed in — the lib never reads the clock.
2. `server.js::GET /api/activity` — thin Hono wrapper. Reads `period` (`180d` | `365d` | `all`) and `tz` query params; returns `{ period, tz, today, rangeStart, totalDays, activeDays, currentStreak, longestStreak, days: [{ date, sessions, tokens, costUSD, claudeAiMessages, intensity }] }`. Also listed in `READ_ONLY_API_PATHS` so the popover's cross-origin fetch from `tauri://localhost` clears the wildcard CORS.
3. `popover/heatmap.js` — vanilla renderer. Classic script (not ES module) that exposes `window.ClaugeHeatmap.render(rootEl, data, options)`. Loaded by BOTH dashboard (`public/index.html`) and popover (`popover/index.html`) via `<script src="…/popover/heatmap.js" defer></script>`. Same palette on both surfaces (single orange ramp at hue 40); variant only swaps cell size + label visibility.
4. `popover/heatmap.css` — the orange ramp tokens (`--cell-0` through `--cell-4` in oklch) plus the host scroll wrapper. Loaded by both surfaces too.

`claudeAiMessages` is always `0` in v0.9.4. The `UsageStore` only persists the most recent ingest, so per-day claude.ai history isn't available yet. The field is plumbed through both the API and the renderer so the per-day breakdown can be wired up without a shape change. Wiring this for real is a v0.9.5+ follow-up.

**Popover buttons retired in v0.9.4:** the heatmap pushed two pruning decisions. Five items are GONE from the popover; their IDs / handlers / CSS no longer exist:

- `#action-add-account`, `#action-dashboard`, `#action-status` (+ `#action-status-label`, `renderStatusAction()`) — the whole `sect-actions` panel was retired.
- `#footer-refresh` + the `⌘R` keyboard shortcut — auto-refresh runs every 10s; the manual button was redundant.
- `#footer-settings` + the `⌘,` keyboard shortcut — Preferences is reachable via tray right-click (`src-tauri/src/menu.rs`).

**Don't reintroduce.** If a future agent sees a "Refresh" or "Settings" button referenced in screenshots / older code and thinks it's a regression — it isn't, it was a deliberate v0.9.4 removal. Status info still surfaces through `renderHeaderSubhead()`'s "Updated …" subtitle.

**Popover height check** still lives in `native_popover.rs::resizeToContent` (`200..1200`) and is mirrored by `popover/popover.js::resizeToContent`'s same clamp. Heatmap section adds ~120px; the five removed items netted ~170px back, so v0.9.4 popover is shorter than v0.9.3. Plenty of headroom — but if you add another section, check `MAX_POPOVER_HEIGHT` (`native_popover.rs:67`) is still respected.

## Communication & timezone

- **All times in BDT (UTC+6).** When generating timestamps, dates, or schedules, convert to BDT and label it.
- **Plain-English explanations** of technical terms in conversation, even obvious ones (e.g., "Keychain — macOS's encrypted credential store"). Adnan reads but doesn't write code.
- **No emojis** in code or commits unless explicitly requested.
- **Short, scannable updates** — Adnan reads on mobile often.

## Out-of-scope behaviors

Do not, without explicit user sign-off:

- Modify `.github/workflows/release.yml` — tag-driven, sensitive.
- Modify `src-tauri/tauri.conf.json` updater section, bundle identifier, or signing config.
- Touch `src-tauri/capabilities/main.json` permissions list outside of new-command additions (see landmine 1).
- Modify CHANGELOG.md historical entries.
- Add new dependencies to `package.json` or `Cargo.toml`.
- Run `git push origin v*` (tag pushes trigger releases).
- Run `git push --force` against any branch.

For everything else, see `VISION.md` for what auto-merges vs needs sign-off.

## Cross-cutting rules

Adnan's global rules live in `~/.claude/CLAUDE.md` (loaded automatically by Claude Code). When that file conflicts with this one, this file wins because it's project-specific.
