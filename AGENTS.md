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

## Load-bearing conventions (data contract)

The cost math depends on a handful of invariants that aren't obvious from reading any single file. Touch any of these and re-run `test/parser.test.js` + `test/cost-calculator.test.js` + `test/aggregator.test.js`. If a change feels like it conflicts with one of these, raise it as a separate refactor task instead of silently bending the contract.

### 1. JSONL turns are deduped by `requestId`

A single assistant API request emits **three** JSONL lines in `~/.claude/projects/<encoded>/<session>.jsonl` — one per content-block type (`thinking`, `text`, `tool_use`). All three carry the **same** `usage` block, so summing them naively triples the token count.

`lib/parser.js::parseSession` deduplicates by `record.requestId`: the first assistant record for a given requestId becomes the canonical turn; subsequent records for the same requestId merge content blocks into the same turn but do **not** add tokens. Records without `requestId` are dropped (they're orphan content blocks from interrupted streams).

Anything new that traverses JSONL records and accumulates tokens **must** dedup. The safest path is to consume `parser.parseSession`'s output (which is already deduped) instead of reading JSONL directly.

### 2. Cache-tier columns: `ephemeral_5m` vs `ephemeral_1h`

Anthropic's `usage.cache_creation` object has two fields with distinct economics:

- `ephemeral_5m_input_tokens` — 5-minute cache, billed at the higher write rate.
- `ephemeral_1h_input_tokens` — 1-hour cache, billed at an even higher write rate.

`lib/parser.js::normalizeUsage` lifts these into `cacheCreate5m` and `cacheCreate1h` separately. **Don't collapse them**. `cost-calculator.js::computeTurnCost` reads each at its own rate (`cache_creation_input_token_cost` and `cache_creation_input_token_cost_above_1hr`). Cache *read* tokens (`cache_read_input_tokens`) are a third bucket with a fourth rate — also tracked separately.

The legacy JSONL field name is `cache_creation_input_tokens` (no tier breakdown). It's still emitted by some session files and is **not** what we use. Always prefer `cache_creation.ephemeral_*` over the legacy aggregate.

### 3. Cost is **always** recomputed from rates — never read from `costUSD`

JSONL records sometimes carry a `costUSD` field. **Do not use it.** It's frequently stale (rate changes since the session ran) or outright wrong (intermediate streaming snapshots).

`lib/cost-calculator.js::computeTurnCost` is the canonical path: it reads `usage.{input,output,cache_read,cache_creation.ephemeral_5m,cache_creation.ephemeral_1h}_tokens` and multiplies each by the current `priceTable` entry for the model. The `priceTable` is loaded from LiteLLM's `model_prices_and_context_window.json` (vendored fallback at `lib/litellm-prices.fallback.json`), with optional env-var overrides for models LiteLLM doesn't track yet.

`lib/cost-calculator.js`'s top-of-file comment locks this: `NEVER reads costUSD from JSONL. Cost is always recomputed from token counts and rates.`

### 4. Never compute cost from `total_tokens` or summed totals

Even given a correct dedup, computing `total_tokens × some_unified_rate` produces a wrong cost. The four token classes have **different rates** (input / output / cache_read / cache_creation), and the cache-creation class itself splits by tier. There is no single "average" rate that gives the right answer.

If you find yourself reaching for a `totalTokens(usage) * rate` shortcut, stop. Either call `computeTurnCost(turn, rates)` (correct) or sum the four/five components × their respective rates explicitly. The TokenTracker competitor (`mm7894215/TokenTracker`) shipped a regression around this in early 2026; their CLAUDE.md now documents the same warning.

### 5. Tokens-summary aggregator preserves the same shape

`lib/aggregator.js` and its `aggregateUsage` helper keep the same field names (`inputTokens`, `outputTokens`, `cacheRead`, `cacheCreate5m`, `cacheCreate1h`, `webSearches`, `webFetches`). The dashboard, popover, and CSV/JSON exporter all assume that shape. Adding a new token class means updating all three consumers in lock-step.

`lib/parser.js`'s top-of-file comment cross-references this section. Update both if you change the dedup or normalization rules.

## Known landmines (read before touching these areas)

### 1. Tauri 2 IPC needs registration in THREE places

Adding a new `#[tauri::command]` requires updating:

1. `src-tauri/src/lib.rs` — register in the `invoke_handler!` macro.
2. `src-tauri/build.rs` — add to the `APP_COMMANDS` allowlist (tauri-build reads this).
3. `src-tauri/capabilities/main.json` — add to the `permissions` array.

Missing any one of the three = silent IPC rejection from JS with no useful error. The browser console may show `Command "foo" not allowed` or just hang.

v0.9.4 added `scripts/validate-ipc-triple-register.cjs` (runs in `npm run check`) which scans `src-tauri/src/*.rs` for `#[tauri::command]` and asserts each one is in `generate_handler![]`, that each `APP_COMMANDS` entry has a matching command + `allow-<kebab>` capability, and that no dead `allow-*` permissions linger. CI fails fast on drift.

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
- **WKWebView transparency stack** (v0.9.4 — four properties, all load-bearing):
  - `setUnderPageBackgroundColor: NSColor.clearColor` (v0.9.1+). Clears the WebView's over/under-scroll fill.
  - `setValue: NO forKey: "drawsBackground"` (v0.9.4). KVC trick used by Slack / Linear / Notion on macOS 12+; the public setter only landed in macOS 14. Stops the WebView from painting an opaque background BEFORE the page renders.
  - `setWantsLayer: true` + `layer.setBackgroundColor(NSColor.clearColor.CGColor)` + `layer.setOpaque: NO` (v0.9.4). Clears the host NSView's CALayer fill so the parent NSVisualEffectView shows through.
  Without ALL FOUR, the popover stack is: dark NSPopover chrome → opaque WKWebView host → page (CSS at any alpha doesn't matter because the WKWebView's own fill blocks the vibrancy material). Took 4 iterations to find this in v0.9.4 smoke — don't drop any of the four "to clean up".
- **`NSVisualEffectView(HudWindow, BehindWindow, Active)` wrapping the WKWebView** (v0.9.4). NSPopover's default chrome is opaque dark in dark mode — no built-in vibrancy. We replace it by installing our own NSVisualEffectView as the content view's root and adding the WKWebView as a subview with width+height autoresize (mask = 18). HudWindow matches the dashboard's `apply_vibrancy(HudWindow, ...)` material so both surfaces composite the same CSS wash onto the same OS layer.
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

### 16. Tauri bridge + copy registry (v0.9.4) — both infrastructure is wired, migration is partial

`popover/lib/tauri-bridge.js` is the canonical facade for every `tauri.invoke()` call. **New code should call `window.ClaugeBridge.xxx()` instead of `window.__TAURI__.core.invoke(...)`.** The bridge file enumerates every command in one place — pair it with `scripts/validate-ipc-triple-register.cjs` and you can audit the whole IPC surface from two files.

Existing callsites still use raw `__TAURI__.core.invoke()`. Migration is incremental: `public/connections.js`, `public/app.js`, `public/onboarding/onboarding.js`, and `popover/splash.js` will move to the bridge across follow-up commits. **Don't add new raw invokes.** If you spot one that's safe to migrate while you're touching nearby code, do it as a separate small commit.

`popover/copy.json` + `popover/lib/copy.js` are the parallel story for user-facing strings. **New strings should be added to `copy.json` and called via `window.t('key.path', { params })`.** Validator at `scripts/validate-copy-registry.cjs` (in `npm run check`) catches typos in t() keys and ensures the JSON is well-formed. Same incremental-migration shape: the registry is wired, existing inline strings stay inline until each one is migrated.

Both bridges are loaded as classic scripts (not ES modules) to keep the dashboard's mixed loading model coherent (`app.js` is an ES module but everything else under `public/` is classic-script for compatibility with the popover's WKWebView).

### 17. Windows Rust portability — `std::os::unix` doesn't exist on Windows

Any `#[tauri::command]` (or any code in `src-tauri/src/`) that touches Unix-only stdlib paths (`std::os::unix::fs::symlink`, `std::os::unix::prelude::*`, etc.) will fail the Windows half of the release matrix at "Run Rust unit tests" with `error[E0433]: cannot find 'unix' in 'os'`. The macOS half compiles fine because macOS IS unix.

**Pattern: per-platform implementations with the same signature.** Mirrors `native_popover.rs::init` and `reload_for_port`:

```rust
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn install_cli_symlink() -> Result<String, String> {
    Err("install_cli_symlink is macOS-only in v0.9.4 — Windows + Linux variants ship in v0.9.5+.".to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn install_cli_symlink() -> Result<String, String> {
    // real implementation using std::os::unix::fs::symlink
}
```

Both compile to the same `pub fn` symbol on their respective targets, so `generate_handler![ipc::install_cli_symlink]` in `lib.rs` resolves cleanly on both — no per-platform cfg in lib.rs needed. Any helper function (e.g., `resolve_bundle_cli_path`) used only by the macOS impl should ALSO be `#[cfg(target_os = "macos")]` to avoid unused-function warnings on Windows.

Caught by the B.7 IPC-triple-register validator? **No** — that validator only checks registration consistency, not platform portability. A future v0.9.5+ idea: extend it to grep for `std::os::unix::` outside macOS-cfg blocks.

### 18. `cargo tauri dev` quirks that bit v0.9.4 hard

Two non-obvious behaviors during the v0.9.4 vibrancy iteration cycle:

**a. `on_navigation` fires for the initial URL too.** In production builds `WebviewUrl::App("splash.html")` resolves to `tauri://localhost/splash.html` which the existing allowlist catches. In dev mode it resolves to `http://127.0.0.1:1430/splash.html` (Tauri's dev server) — NOT in the allowlist. The handler blocks the initial nav and the dashboard renders blank. Look for `Blocked dashboard navigation to http://127.0.0.1:1430/splash.html` in the dev log.

The fix already in `windows.rs::on_navigation`:

```rust
#[cfg(debug_assertions)]
if u.scheme() == "http"
    && matches!(host, Some("127.0.0.1") | Some("localhost"))
    && u.port_or_known_default() == Some(1430)
{
    return true;
}
```

If you touch `on_navigation`, keep this allowance or `cargo tauri dev` will silently blank-window the dashboard while production builds work fine.

**b. `cargo tauri dev` does NOT auto-pick-up rebuilt sidecar binaries.** It launches `target/debug/clauge-server`, NOT `src-tauri/binaries/clauge-server-<arch>-apple-darwin` (which is what `npm run build:sidecar` writes). After build:sidecar, the running tauri:dev keeps using the OLD binary. Workarounds:

- Copy the new binary into place: `cp src-tauri/binaries/clauge-server-aarch64-apple-darwin src-tauri/target/debug/clauge-server`, then `pkill -9 clauge-server` so the tauri:dev supervisor respawns with the new binary.
- Or fully restart: `pkill -9 -f "clauge\|cargo run" && npm run tauri:dev` — picks up the binary from `target/debug/clauge-server` which Tauri itself copied from `src-tauri/binaries/` on startup.

Symptom when you forget: changes to popover JS / CSS / HTML don't appear even though `curl http://127.0.0.1:3456/popover/popover.css` shows the new file on disk — because the bundled SEA binary serves embedded assets from its OWN copy, not the disk path.

### 19. Workflow steps using bash syntax MUST declare `shell: bash`

`windows-2022` runners default to PowerShell, NOT bash. Any `run:` block that uses:

- `${VAR#prefix}` / `${VAR%suffix}` (parameter expansion)
- `pipe | grep | cut` (Unix pipelines)
- `if ! cmd; then ... fi` (bash conditionals)
- `for v in ...; do ... done` (bash loops)
- `[ "$a" = "$b" ]` or `[[ ... ]]` (test expressions)

...will fail with cryptic PowerShell errors unless the step declares `shell: bash` (Git Bash is installed on the windows-2022 image). The B.2 `Verify version triple matches tag` step bit this exactly once in v0.9.4 — fixed by adding `shell: bash` under the `env:` block.

The macOS-14 runner defaults to bash so steps without `shell:` work there silently, hiding the issue from cross-platform testing.

### 20. HTML pages hosting JS that uses a `popover/lib/` facade MUST load its definer first

Two facades currently fall under this rule:

| Facade | Definer file | Caller pattern |
|---|---|---|
| `window.ClaugeBridge` | `popover/lib/tauri-bridge.js` | `ClaugeBridge.*` calls |
| `window.t` (copy registry) | `popover/lib/copy.js` | `t('some.key.path', …)` calls |

Every HTML page in `popover/` or `public/` that loads a JS file referencing either facade MUST also include the definer script tag (e.g. `<script src="lib/tauri-bridge.js">` or the absolute `/popover/lib/copy.js`) **BEFORE** the calling JS. Each HTML page is an independent loader — there is NO inheritance from sibling HTML pages.

Shipping an HTML page that loads facade-using JS without the definer means the facade is undefined at runtime:

- **ClaugeBridge missing** → guards like `if (!window.ClaugeBridge || !ClaugeBridge.isTauriAvailable()) return;` short-circuit silently. The local server is running fine; the page just can't detect it. Caught by the **v0.9.5 → v0.9.6 hotfix** (`popover/splash.html` was missing the bridge tag after the B.6 migration of `splash.js`).
- **t() missing** → first call to `t('some.key', …)` throws `ReferenceError: t is not defined` and aborts whatever render was in progress. Caught by the **v0.9.7 → v0.9.8 hotfix** (`public/index.html` loaded `/popover/heatmap.js` — whose `defaultTooltip()` calls `t()` per non-empty cell — without loading `/popover/lib/copy.js`; the dashboard heatmap stayed blank).

Full postmortems in `AGENT_LEARNINGS.md`.

**Enforced at lint time by** `scripts/validate-html-facade-loads.cjs` (introduced v0.9.7, extended to both facades v0.9.8). The validator scans all HTML in `popover/` and `public/` (excluding `public/popover/` which is a build mirror), maps each `<script src>` to its on-disk JS file, and asserts per facade: if any loaded JS uses the facade, the HTML must also load the definer BEFORE it. Wired into `npm run check`.

**To extend with a new facade**, add an entry to the `FACADES` array at the top of `scripts/validate-html-facade-loads.cjs` (name + definesRe + usesRe + definerLabel). No other code changes needed — the per-facade check is mechanical.

### 21. Version bumps require ALL FOUR files in lockstep

Any release tag (`vX.Y.Z`) must come with version-string updates in:

| File | Field |
|---|---|
| `package.json` | `"version": "X.Y.Z"` |
| `src-tauri/Cargo.toml` | `version = "X.Y.Z"` (under `[package]`) |
| `src-tauri/tauri.conf.json` | `"version": "X.Y.Z"` |
| `src-tauri/Cargo.lock` | `version = "X.Y.Z"` inside the `[[package]] name = "clauge"` entry |

**Why this is a landmine:** the `check` workflow (PR CI) runs `cargo test --quiet` — NO `--locked`. The `Release` workflow (tag-triggered) runs `cargo test --locked` — Cargo refuses to proceed if Cargo.lock would need updating to match Cargo.toml. So a PR that bumps the first three files but forgets Cargo.lock passes CI cleanly and then **fails the release pipeline at "Run Rust unit tests"** with `cannot update the lock file ... because --locked was passed`. v0.9.8's PR #5 hit this exact path — a follow-up PR #6 had to add the one-line Cargo.lock bump before the release could ship. The retag-and-rerun cycle also surfaced a flaky-runner cancellation.

**Before tagging,** verify locally:

```bash
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

If it errors, Cargo.lock still has the previous version and must be bumped before tagging. Pure `cargo check` (no `--locked`) would silently rewrite Cargo.lock — which is fine on PR but only catches the bug AFTER you've already committed.

Alternative auto-fix that's still safe to run from the version-bump PR branch: `cargo check --manifest-path src-tauri/Cargo.toml` once, then commit any Cargo.lock changes. The lock is repo-tracked so it must be committed alongside the other three files.

### 22. Auto-refresh paths must NOT destroy long-lived animated children

When a recurring `setInterval` / `setTimeout` callback rebuilds a DOM region (typically `el.innerHTML = template(data)` or `el.replaceChildren(...)`), EVERY child of that region is destroyed and recreated — including descendants whose CSS keyframe animation is mid-cycle. The animation restarts at frame 0 on each tick. With a 60-second cadence and a 2-second `pulse`, the user perceives a subtle brightness/scale snap once a minute. v0.9.4 → v0.9.8 shipped exactly this regression for `<span class="dot-live">` inside `#plan-meta`, caught and fixed in v0.9.9 (full postmortem in `AGENT_LEARNINGS.md`).

**Pattern: split the render into two phases.**

1. **Structural phase** — runs only on **shape transitions** (placeholder → ingested, healthy → degraded, balance-line absent → present, etc.). Reassign `innerHTML` here. Track each distinction with a module-level flag so the rebuild can be skipped when the shape hasn't changed (see `__planCardMode`, `__planStatusTone`, `__planInlineHasBalance` in `public/app.js`).
2. **Surgical phase** — runs on every tick. Walks the existing DOM and mutates only the leaf text/attribute values. Use `setTextIfChanged(el, val)` (defined in `public/app.js`) — it prefers `el.firstChild.data = val` on single-text-node children, which fires `characterData` mutations (NOT `childList`), so siblings and their animations are untouched. Fall back to `el.textContent` only when the element has mixed children.

`Node.textContent = val` is also UNSAFE for the surgical phase — its setter spec ALWAYS replaces all children with a fresh text node, even when the new value equals the old. That fires `childList` mutations and can restart sibling animations through layout interplay. Prefer `Text.data` writes via the `setTextIfChanged` helper.

**Verifying:** A Playwright `MutationObserver` against the auto-refresh region should record only `characterData` mutations across cycles when the underlying data is unchanged — **zero `childList` mutations** on the region root. Tag a long-lived animated child with `dataset.flickertag = 'A'` after installing the observer; if the tag survives all refresh cycles, element identity is preserved and the animation isn't restarting. v0.9.9's verification did exactly this on PORT=3499 across three 60s cycles.

**Existing auto-refresh paths to mind** (touch these and re-read this landmine):

- `public/app.js` plan-card auto-refresh (60s) — surgical-update split in v0.9.9 (`renderPlanCapacity`, `renderFinanceSide`; helpers `setTextIfChanged` / `setAttrIfChanged` / `updateBigRings` / `updatePlanMeta` / `updatePlanInline`).
- `popover/popover.js` popover auto-refresh (10s) — currently rebuilds via `renderPopover()` on every tick. No visible flicker today because the popover surface has no long-lived CSS-animated element, but the same surgical-update pattern applies if a `.dot-live`-style element is ever added.

### 23. WebviewWindow URLs pointing at the sidecar HTTP origin MUST listen for `sidecar-ready`

If `tauri::WebviewWindowBuilder::new(..., WebviewUrl::External(http://127.0.0.1:PORT/...))` is called BEFORE the sidecar has bound `PORT`, the resulting webview gets `ERR_CONNECTION_REFUSED` on its initial load and STAYS in error state. Tauri's `WebviewWindow` doesn't auto-retry; there's no built-in reload-on-failure. This shipped as the v0.9.0 Apple App Store rejection (Guideline 2.1(a)): the first-launch wizard opened at `T+500ms` while the sidecar took 1–8 s to bind (loadPriceTable HTTP fetch + serveStatic setup + listenWithRetry). The reviewer saw a blank "Welcome to Clauge" window and rejected. Full postmortem in `AGENT_LEARNINGS.md`.

**Rule:** never gate a sidecar-URL `WebviewWindow` on a fixed `tokio::sleep` delay. The sidecar's cold-start latency in sandbox is variable (1–8 s) and the 500 ms / 1 s / 2 s margins look fine in dev but break under App Review or fresh-install conditions. Use the `sidecar-ready` event listener pattern instead.

**Pattern (the canonical implementation lives at `src-tauri/src/lib.rs::spawn_wizard_window_once`):**

1. **Helper function** — takes `&AppHandle`, `port: u16`, and a `&std::sync::atomic::AtomicBool` race-guard. Calls `swap(true, SeqCst)`; if it returns true, bail (another caller already won). Otherwise builds the `WebviewWindow`. On `build()` error: log only — NEVER mutate a persistent flag like `onboarding_completed` to permanently disable the window (a transient race must not become a permanent dead state).
2. **Primary trigger** — `app.listen("sidecar-ready", |event| { let port = parse_payload(event); spawn_window_once(&app, port, &guard); })`. The event payload is `{"port": <u16>}`.
3. **Timeout fallback** — `tauri::async_runtime::spawn(async move { tokio::time::sleep(30s).await; spawn_window_once(&app, 3456, &guard); })`. If `sidecar-ready` never fires (sidecar genuinely broken), at least show a window with an error page rather than appear completely unresponsive. 30 s is the order of magnitude where a user would assume the app launch failed and force-quit.

**Both spawn paths MUST emit `sidecar-ready`:**

- SpawnAt (sidecar.rs `spawn_one` captures PORT_MARKER): already emits.
- External (lib.rs `DiscoveryResult::External`): added in v0.9.10. Without this, npx-clauge users running an external server would only hit the 30 s wizard timeout fallback.

**Alternative when the bundled-asset path is acceptable:** use `WebviewUrl::App(<bundled-html>)` (loads from `frontendDist`) instead of `WebviewUrl::External`. The dashboard does this with `windows.rs:27` → `splash.html`, then splash.js listens for `sidecar-ready` and navigates to `http://127.0.0.1:PORT/`. This is more robust than the listener-gate-then-open pattern (window appears immediately with content), but requires the HTML/JS/CSS to be bundled into `popover/` (Tauri's `frontendDist`). For the wizard we chose listener-gate-then-open because the wizard's HTML lives in `public/onboarding/` and migrating it to `popover/` would touch ~10 files.

**Existing sidecar-URL WebviewWindow surfaces to mind:**

- First-launch wizard (`lib.rs::run::setup` onboarding block) — protected since v0.9.10 (the post-Apple-rejection fix).
- Native popover WKWebView (`native_popover.rs::create_popover`) — protected by `reload_for_port` auto-recovery (it loads against a default port at init, then reloads when sidecar binds). DIFFERENT pattern; works because the popover is hidden until clicked, so the user typically clicks AFTER sidecar is ready.

### 24. MAS-flavor sidecar binaries MUST be wrapped in their own `.app` bundle inside `Contents/Helpers/`

Discovered in the v0.9.10 Apple resubmission cycle (2026-05-28). The naïve placement of the sidecar binary at `Clauge.app/Contents/MacOS/clauge-server` cannot satisfy both of Apple's contradictory requirements for MAS submissions:

1. **Apple Transporter validation** (static check at upload) hard-requires `com.apple.security.app-sandbox=true` on every Mach-O executable in the bundle. No bypass. From the rejection: `"App sandbox not enabled. The following executables must include the 'com.apple.security.app-sandbox' entitlement with a Boolean value of true in the entitlements property list"`. HTTP 409 STATE_ERROR.VALIDATION_ERROR.

2. **`libsystem_secinit.dylib::_libsecinit_appsandbox`** (runtime, during dyld init) hard-requires the binary to have an Info.plist with `kCFBundleIdentifierKey` reachable from code signature information. A standalone Mach-O binary has no embedded Info.plist. With `app-sandbox` set, secinit can't find a bundle identifier, fails per-binary container setup, and the process SIGTRAPs before any user code runs.

The two requirements meet at: helpers must live in their OWN `.app` bundle (which has its own `Info.plist`). This is the documented Apple pattern (Electron/Chromium do this for helper renderers; Apple's docs at `developer.apple.com/documentation/security/app_sandbox` describe it as the standard).

**Required structure for any sandboxed Mac App Store flavor of Clauge:**

```
Clauge.app/
├── Contents/
│   ├── Info.plist                          (main app — CFBundleIdentifier=com.clauding.clauge)
│   ├── MacOS/
│   │   └── clauge                          (Tauri main binary)
│   └── Helpers/
│       └── Clauge Helper.app/
│           ├── Contents/
│           │   ├── Info.plist              (helper — CFBundleIdentifier=com.clauding.clauge.helper)
│           │   └── MacOS/
│           │       └── clauge-server       (Node SEA sidecar)
```

**The helper.app Info.plist must contain at minimum:**

- `CFBundleIdentifier=com.clauding.clauge.helper` (or whatever subdomain of the parent is used)
- `CFBundleExecutable=clauge-server`
- `CFBundlePackageType=APPL` (or `BNDL` — verify against Apple's current convention)
- `CFBundleVersion=<matching parent's build>` (CFBundleVersion 4 for v0.9.10)
- `CFBundleShortVersionString=<matching parent's marketing version>`
- `LSUIElement=true` (no Dock icon)
- `LSMinimumSystemVersion=<matching parent>` (12.0 for current Clauge)

**Build script responsibility (`scripts/build-mas-clean.sh`):**

The Tauri `externalBin` mechanism copies the sidecar binary to `Contents/MacOS/`. A post-build step in the MAS build script must:

1. Move `Contents/MacOS/clauge-server` to `Contents/Helpers/Clauge Helper.app/Contents/MacOS/clauge-server`.
2. Generate the helper Info.plist (heredoc + `plutil -convert binary1` if Apple prefers binary plists).
3. Re-sign INSIDE-OUT: helper binary → helper bundle (with sidecar entitlements including `app-sandbox=true`) → main app bundle (re-seal so the parent's signature includes the helper's signature).

**Runtime responsibility (`src-tauri/src/sidecar.rs`):**

Tauri's default sidecar plugin (`app.shell().sidecar("clauge-server")`) hardcodes `<bundle>/Contents/MacOS/<name>` on macOS. With the helper in `Contents/Helpers/`, the plugin can't find it. The MAS-flavor spawn path bypasses the shell plugin entirely:

- Resolve the helper path at runtime via `app.path().resource_dir()` → parent → `Helpers/Clauge Helper.app/Contents/MacOS/clauge-server`. The helper function is `resolve_helper_path(app)` in `sidecar.rs`.
- Spawn via `tokio::process::Command::new(helper_path)` with `kill_on_drop(true)` for panic-safety, stderr piped (for parsing the `CLAUGE_BOUND_PORT=` marker), stdout/stdin nulled.
- Use `libc::kill(pid, SIGTERM)` for kill — avoids the `&mut self` constraint on `tokio::process::Child::kill()` that would otherwise force a Mutex-or-oneshot dance between the supervisor's quit path and the wait-task that owns the Child.

Type unification (so the supervisor loop is single-path across flavors):

- `SidecarChild` enum wraps either `tauri_plugin_shell::process::CommandChild` (DMG) or `NativeChild` (MAS). API surface: `pid() -> u32`, `kill(self) -> io::Result<()>`. `AppState::children` stores `Vec<SidecarChild>` regardless of flavor.
- `SidecarEvent` enum mirrors the subset of `CommandEvent` we use: `Stderr(Vec<u8>)` and `Terminated { code, signal }`. Both flavors produce `UnboundedReceiver<SidecarEvent>` from `spawn_helper_process(app)`. The DMG path adds a small tokio forwarding task that translates `CommandEvent` → `SidecarEvent`; the MAS path emits SidecarEvent directly from its stderr-reader and wait tasks.
- Cfg-gate imports of `CommandChild` + `CommandEvent` from `tauri_plugin_shell` with `#[cfg(not(feature = "mas"))]` so the MAS build doesn't warn on dead imports.

Cfg-gate the path resolution + native spawn helpers on `#[cfg(feature = "mas")]`. The DMG flavor's spawn path stays unchanged (still uses `app.shell().sidecar("clauge-server")`).

**See landmine #25 for the env-variable propagation pitfall when refactoring spawn paths.**

**Helper entitlements — `com.apple.security.inherit=true` is LOAD-BEARING:**

The helper's `entitlements-sidecar.mas.plist` MUST contain:

- `com.apple.security.app-sandbox=true` — satisfies Transporter's static "every Mach-O must declare app-sandbox" check.
- `com.apple.security.inherit=true` — **THIS** is what makes the helper.app pattern actually work at runtime. Tells the kernel "attach this helper to the parent's existing sandbox container; do NOT create a fresh per-binary container." With `inherit`, the helper:
  - Bypasses `libsystem_secinit`'s per-binary container setup (no `_libsecinit_appsandbox.cold.9` SIGTRAP — that fires when secinitd tries to apply a fresh sandbox profile via SYSCALL_SET_USERLAND_PROFILE and the kernel rejects it).
  - Runs in the parent's `~/Library/Containers/com.clauding.clauge/` container; no separate `~/Library/Containers/com.clauding.clauge.helper/` is created.
  - **Inherits the parent's `startAccessingSecurityScopedResource` grant** on `~/.claude/` via process-tree sandbox state sharing. No `application-groups` entitlement needed. No bookmark blob migration to a group container needed.
- `com.apple.security.cs.allow-jit=true` — required for the SEA Node binary's V8 JIT. Not a sandbox entitlement; a code-signing hardened-runtime flag, not affected by `inherit`. Has to be on the helper's own signature because the JIT permission check runs per-binary.

The helper MUST NOT declare any other entitlements (network, files, etc.). With `inherit`, those are picked up from the parent's full set in `entitlements.mas.plist`. Listing them on the helper too is redundant at best and a potential conflict signal to App Review at worst. Reference: Apple Technical Note TN2206; Chrome's `Google Chrome Helper.app` and Electron renderer helpers use this exact pattern.

**Empirically validated 2026-05-28 (session `2026-05-28-helper-inherit-env-passthrough-bug-session.md`):** with the inherit entitlement, the helper boots cleanly, the dashboard renders fully, and Apple's Guideline 2.1(a) "app doesn't load content after launch" is demonstrably resolved. The mid-cycle hypothesis that app-groups would be needed turned out to be wrong — inherit handles the bookmark sharing.

**First-spawn-after-entitlement-change transient:** Immediately after rebuilding with new helper entitlements (e.g. adding `inherit`), the FIRST spawn attempt sometimes still SIGTRAPs in `_libsecinit_appsandbox.cold.9`. CrashBreaker's silent respawn (first crash = silent) handles it transparently; the second-and-subsequent spawns work cleanly. Cause is likely secinitd's profile cache not invalidating immediately. Production users won't see this because they install once and don't change entitlements between launches. Don't add workaround code — the existing CrashBreaker logic is the right behavior.

**Anti-patterns to NEVER ship for the MAS flavor:**

- Sidecar binary at `Contents/MacOS/clauge-server` with `app-sandbox` entitlement — runtime SIGTRAP (v0.9.10 pre-helper, `_libsecinit_appsandbox.cold.6`, no kCFBundleIdentifierKey).
- Sidecar binary at `Contents/MacOS/clauge-server` WITHOUT `app-sandbox` entitlement — Transporter rejects (v0.9.10 commit cd83087, HTTP 409).
- Helper bundle WITHOUT `com.apple.security.inherit=true` — runtime SIGTRAP (v0.9.10 first helper.app attempt, `_libsecinit_appsandbox.cold.9`, SYSCALL_SET_USERLAND_PROFILE rejection).
- Helper bundle with `application-groups` entitlement added "for safety" — redundant with `inherit`, signals architectural hedging to App Review.
- Ad-hoc signing (`codesign --sign -`) of a binary with restricted entitlements (`application-identifier`, `team-identifier`) — AMFI -424 at launch.
- Real-cert signing with embedded Production provisioning profile for direct dev-machine launch — taskgated-helper CPProfileManager -215. Only Development profiles can be installed for direct launch; MAS uses Production profiles. The `--local-test` mode in the build script strips this for sandbox-equivalent verification.

**Cross-references:**

- Full session postmortems:
  - `~/Projects/claude-second-brain/01_Projects/Clauge/2026-05-28-mas-blocked-helperapp-needed-session.md` (architectural pivot)
  - `~/Projects/claude-second-brain/01_Projects/Clauge/2026-05-28-helper-inherit-env-passthrough-bug-session.md` (inherit-entitlement validation + env-passthrough bug discovery)
- `AGENT_LEARNINGS.md` 2026-05-28 entry (currently the wizard-race-framed entry is stale and needs amending — the actual fix is helper.app + inherit + env-passthrough, not the wizard race).
- Apple docs:
  - `developer.apple.com/documentation/security/app_sandbox` (sandbox model + helper pattern)
  - Apple Technical Note TN2206 — Code Signing — On Bundle Format
  - `developer.apple.com/documentation/bundleresources/entitlements/com_apple_security_inherit` (inherit entitlement reference)

### 25. When the MAS spawn path bypasses Tauri's shell plugin, env vars must be forwarded EXPLICITLY

Discovered 2026-05-28, session `2026-05-28-helper-inherit-env-passthrough-bug-session.md`. The DMG flavor's `app.shell().sidecar("clauge-server").env("NO_OPEN", "1").spawn()` chain implicitly inherits the parent process's full environment in addition to the keys passed via `.env()`. The MAS flavor's `tokio::process::Command::new(helper_path).env("NO_OPEN", "1").spawn()` ALSO inherits the parent's environment by default — but the parent process's environment doesn't have `CLAUDE_DIR` set on it. In the MAS flavor, the bookmark-resolved path lives in a Rust `OnceLock<PathBuf>` (`security_scoped_bookmark::MAS_CLAUDE_DIR`), NOT in the OS-level env. The supervisor must explicitly bridge that OnceLock to the spawn-time env.

**The rule:** when spawning the helper in MAS mode, read `MAS_CLAUDE_DIR.get()` AT SPAWN TIME (not cached, not at supervisor-startup-time) and forward it as `CLAUDE_DIR` on the spawned process. The OnceLock can be populated AFTER the supervisor's first spawn (via `grant_claude_dir_access` IPC on first-launch wizard grant), and the helper respawn must pick up the new value.

**Where this lives in code:**

```rust
// In src-tauri/src/sidecar.rs, inside spawn_native_helper, BEFORE cmd.spawn():
#[cfg(feature = "mas")]
{
    if let Some(claude_dir) = crate::security_scoped_bookmark::MAS_CLAUDE_DIR.get() {
        cmd.env("CLAUDE_DIR", claude_dir);
    }
}
```

**Symptom of the bug (so future readers can recognize it):**

- Wizard grant completes successfully (the user picks `~/.claude/`, NSOpenPanel dismisses, bookmark blob persists in `settings.json`).
- Connections panel shows "Granted at /Users/adnanrashid/.claude" with a green dot.
- BUT the dashboard's Overview tab stays empty ("No plan data yet").
- `curl http://127.0.0.1:<port>/api/health` returns `claudeDir: /Users/adnanrashid/Library/Containers/com.clauding.clauge/Data/.claude` — the sandbox-redirected fake path, NOT the user's real `/Users/adnanrashid/.claude`.

**The DMG flavor doesn't have this issue** because DMG runs in a non-sandboxed parent that has direct access to `$HOME/.claude/`. The helper inherits `$HOME` from the parent's env and resolves `.claude/` from there. The MAS flavor's parent process has `$HOME` sandbox-redirected, so `$HOME/.claude/` is the empty redirect path — only an explicit `CLAUDE_DIR` env (or a Rust-side path override) routes the helper to the real bookmark-resolved path.

**Other env vars to check** if the SEA Node `server.js` reads them:

- `CLAUDE_DIR` — the bookmark-resolved Claude data dir (this session's bug)
- `CLAUDE_PROJECTS_DIR` — overrides `$CLAUDE_DIR/projects/`
- `CLAUDE_CONFIG_DIR` — overrides `$CLAUDE_DIR/`
- `NO_OPEN` — already wired correctly

When adding new env-driven config in the future, **always check both the DMG path (auto-inherits) AND the MAS path (must explicitly forward).** The MAS path's `tokio::process::Command` is the test for whether the env is actually propagating.

**Anti-pattern:** Setting `std::env::set_var("CLAUDE_DIR", path)` in the parent process so subsequent spawns inherit it. This pollutes the parent's env (visible to other libraries / future code that reads `CLAUDE_DIR`), is non-thread-safe (mutating env is a documented data race in Rust as of 2024), and obscures the actual data flow. The explicit `cmd.env("CLAUDE_DIR", path)` per-spawn is the right pattern.

### 26. MAS launch-at-login MUST use SMAppService, NOT the LaunchAgent plugin

Discovered 2026-05-29. `tauri-plugin-autostart`'s `MacosLauncher::LaunchAgent` writes a plist to `~/Library/LaunchAgents/`. Under the App Sandbox that path is REDIRECTED into the app's container (`~/Library/Containers/com.clauding.clauge/Data/Library/LaunchAgents/`), where launchd never scans it. Result: `app.autolaunch().enable()` returns `Ok` (the write into the container succeeds), but the login item DOES NOT EXIST — a silent no-op, and the onboarding wizard's "added to your login items" copy becomes a lie.

The fix lives in `src-tauri/src/autostart_mas.rs` (mas-gated): register via Apple's `SMAppService.mainApp` (`objc2-service-management` crate), the modern sandbox-correct API. The DMG/Windows flavors KEEP `tauri-plugin-autostart` (LaunchAgent works in a non-sandboxed process). The split is cfg-gated in three places — touch all three together:

- `lib.rs` builder chain: `tauri_plugin_autostart::init(...)` is `#[cfg(not(feature = "mas"))]` (NOT initialized on MAS).
- `lib.rs` first-launch enable block: cfg-split between `app.autolaunch().enable()` (non-mas) and `crate::autostart_mas::enable()` (mas).
- `ipc.rs` `set_autostart` / `get_autostart`: same cfg-split.

**`SMAppService` is macOS 13.0+.** `autostart_mas::is_supported()` runtime-guards every call (`NSProcessInfo::isOperatingSystemAtLeastVersion`), so macOS 12 degrades gracefully (no autostart, no crash) and `minimumSystemVersion` STAYS 12.0 — do NOT bump the floor to 13 for this.

**Verify the real effect, not the return code.** `sfltool dumpbtm | grep -A5 com.clauding.clauge`: a correct MAS registration shows `Type: app (0x2)`, `Flags: [ sandboxed ]`, `Disposition: [enabled, allowed]`. A `Type: legacy agent` entry pointing at `~/Library/LaunchAgents/` is the OLD DMG path, not the MAS one. "`enable()` returned `Ok`" is NOT proof — the LaunchAgent no-op also returns `Ok`.

### 27. App Store Connect submission gotchas (hit live during the v0.9.10 resubmission, 2026-05-29)

Three things bite at MAS submission time, none of them code bugs:

1. **Export-compliance dialog → set `ITSAppUsesNonExemptEncryption = false` in the bundle Info.plist.** On submit, ASC asks "what encryption does your app implement?" Clauge bundles standard TLS (reqwest/`rustls` + the Node sidecar's OpenSSL), so the literal answer is "standard algorithms" — which then asks for a French encryption-declaration **document upload** if the app is available in France. Clauge's encryption is **exempt** (standard HTTPS only), so the correct, paperwork-free declaration is `ITSAppUsesNonExemptEncryption=false`. Add it to the MAS Info.plist so the dialog never appears AND France/EU stays included with no docs. **Wired as of build 5:** `scripts/build-mas-clean.sh` injects it into the main app's `Info.plist` via `PlistBuddy` AFTER `cargo tauri build` but BEFORE the main-app `codesign` (the order is load-bearing — codesign seals `Info.plist`, so modifying it after signing breaks the signature). Verified 2026-05-31: Transporter uploaded build 5 with NO export-compliance prompt. (Build 4 shipped without the key, so the dialog appeared and France was excluded to dodge the doc upload.)
2. **EU DSA trader status must be declared before you can submit/update for the EU.** App Store Connect → Business → Trader Status. Non-trader (individual, free app) keeps you compliant; trader requires public contact details on the EU listing. Not declaring blocks EU submission + removes the app from EU storefronts (stays elsewhere).
3. **The App Store version field must equal the build's `CFBundleShortVersionString`.** A rejected version is editable — bump the version number (e.g. 0.9.0 → 0.9.10) to match the build before the new build (0.9.10) becomes selectable in the Build picker.

Reference: `~/Projects/clauge/SS/appstore/SUBMIT_GUIDE.md` + `APP_REVIEW_NOTES.txt` (paste-ready review notes covering 2.1(a) + 2.4.5(i)). App Store screenshots must be landscape 1280×800 / 1440×900 / 2560×1600 / 2880×1800; the menu-bar popover (portrait) must be composited onto a landscape canvas.

### 28. MAS launch-at-login must be OPT-IN — auto-enabling at first launch violates Apple 2.4.5(iii)

Distinct from landmine #26 (which is about the *mechanism* — SMAppService vs LaunchAgent). This is about *consent*. Apple Guideline **2.4.5(iii)** forbids an app auto-launching or running code at login **without explicit user consent**. v0.9.10 **build 4 was rejected** for exactly this: `lib.rs`'s first-launch block called `autostart_mas::enable()` automatically (the comment literally said "Launch at Login (default ON)") and the onboarding wizard only showed a *notice* ("Clauge has been added to your login items") — an opt-OUT model.

Rules for the MAS flavor:

- **Never auto-register at startup/first launch.** The first-launch autostart block in `lib.rs::run::setup` is now `#[cfg(not(feature = "mas"))]` — DMG/Windows may auto-enable (not App Store; allowed), MAS must not.
- **Launch at Login is enabled ONLY by an explicit user action** — the onboarding wizard Step 3 toggle (`#wizard-autostart-toggle`, default OFF) or the dashboard Settings toggle, both calling `set_autostart`.
- `set_autostart`/`get_autostart` are in `APP_COMMANDS` + `capabilities/main.json` (added build 5) so the dashboard AND the onboarding window (both remote-http origins) can call them; they route by flavor (MAS → SMAppService, DMG/Win → plugin).
- The dashboard toggle must use `ClaugeBridge.getAutostart()/setAutostart()` (flavor-correct), NOT the `plugin:autostart|*` path — the plugin's LaunchAgent silently no-ops in the MAS sandbox (see #26), so the plugin path leaves the Settings toggle disconnected from the real SMAppService state on MAS.
- The popover's `#autostart-toggle` (Preferences panel, `popover/index.html`) is **hidden** as of build 5. It was never wired on any flavor: the native NSPopover hosts a raw `WKWebView` with **no `__TAURI__` injected** (it talks to Rust only via `webkit.messageHandlers.clauge` → `native_popover.rs`, which handles `open_dashboard`/`resize` and nothing else), so `ClaugeBridge`/Tauri-invoke calls cannot work there. Wiring it needs a new `set_autostart` native message handler + an initial-state read — tracked for v0.9.11. Until then, keep it hidden rather than ship a dead control.
- Any new autostart surface (wizard, settings) defaults to OFF and registers only on explicit enable.

### 29. The 5 `.cjs` validators are a SUBSET of CI — the gate is `npm run check`

`scripts/validate-*.cjs` (run via `npm run check:validators`) are only the FIRST of five links in the CI gate. CI (`.github/workflows/check.yml`) runs `npm run check` = `check:validators && check:fmt && check:lint && check:rust-test && npm test`:

1. `check:validators` — the 5 `.cjs` scripts (ipc-triple-register, no-console-log, no-hardcoded-port, copy-registry, html-facade-loads)
2. `check:fmt` — `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
3. `check:lint` — `cargo clippy --all-targets -- -D warnings`
4. `check:rust-test` — `cargo test`
5. `npm test` — the Node test suite

The `&&` chain short-circuits: if `check:fmt` fails, clippy/tests never run — so "the validators pass" says nothing about fmt/clippy/tests. **Before pushing a release branch or claiming CI is green, run the full `npm run check`** (it needs the sidecar binaries at `src-tauri/binaries/` so `build.rs` compiles — `npm run build:sidecar` if missing). Hand edits to `src-tauri/src/*.rs` especially must be run through `cargo fmt`, since fmt is CI's first, short-circuiting gate. This bit the build-5 → main merge (v0.9.10, 2026-06-01): CI sat red on fmt drift for ~2 days while the session believed "validators pass" = clean. See `AGENT_LEARNINGS.md` 2026-06-01.

### 30. `popover/` is the SOURCE; `public/popover/` is a gitignored build mirror — edit the source, not the mirror

The popover assets live in **two** places: `popover/` at the repo root (git-tracked, the source of truth) and `public/popover/` (gitignored — listed in `.gitignore`). `scripts/build-sidecar.mjs` step 0 copies `popover/* → public/popover/*` so the SEA's `serveStatic('/*', root: 'public')` route (and the bundled `sea-bootstrap.cjs` ASSETS list) can serve them. Consequences:

1. **Edit `popover/` (root), never `public/popover/`** — a direct edit to the mirror is overwritten on the next `build:sidecar` and is invisible to git. The `validate-html-facade-loads.cjs` validator scans `popover/` and explicitly **excludes** `public/popover` (confirming the source-of-truth direction).
2. **A running `node server.js` (dev sidecar) serves `public/popover/`, the mirror — NOT your edited source.** So after editing `popover/`, the dev sidecar shows the OLD popover until you regenerate the mirror: run `npm run build:sidecar` (full) or copy just the changed files (`cp popover/<f> public/popover/<f>`). The production DMG/MAS build runs `build:sidecar`, so shipping is automatic — this gotcha only bites local dev/verification.
3. The **dashboard** (`public/index.html`, `public/app.js`, `public/styles.css`) is served directly from `public/` — no mirror, edit in place.

(Hit live 2026-06-02 verifying the Claude Design hide-fix: the dev sidecar kept showing the phantom because the test was hitting the stale `public/popover/` mirror. See `AGENT_LEARNINGS.md` 2026-06-02.)

### 31. Release builds NEVER adopt an external sidecar — dev iteration on a hand-run `node server.js` needs `CLAUGE_ALLOW_EXTERNAL=1`

The v1.0.0 S8 (impersonation) fix made port discovery refuse to *adopt* a sidecar it didn't launch. `should_adopt_external(health_response, allow_external)` (`src-tauri/src/port_discovery.rs:90`) returns `allow_external && version_matches_self(...)`, and `allow_external` is read from the `CLAUGE_ALLOW_EXTERNAL=1` env var (`port_discovery.rs:325`, default `false`). Rationale: a port-squatter on 3456 can forge the public version string in `/api/health` and serve impostor content into a privileged webview, so a release build must own the process it trusts. Consequences for AI agents and local dev:

1. **A hand-run `node server.js` on port 3456 will be KILLED, not reused, by any build that lacks the flag.** `discover_with_retry` (`port_discovery.rs:324`) probes 3456; when `should_adopt_external` says no, it logs `"Not adopting external server on port 3456 …"`, SIGKILLs the PID listening on the port (`kill_pid_on_port`), and spawns its own sidecar. So the classic dev loop — start `node server.js` in one terminal to iterate on the API, then launch the app — silently loses your hand-run server unless you `export CLAUGE_ALLOW_EXTERNAL=1` first.
2. **The flag is necessary but not sufficient — the version must also match.** Even with `CLAUGE_ALLOW_EXTERNAL=1`, adoption only happens when the external server's reported version equals `CARGO_PKG_VERSION` (`version_matches_self`). A stale-version hand-run server is refused (and killed) regardless of the flag.
3. **This is a dev escape hatch only — NEVER set `CLAUGE_ALLOW_EXTERNAL` in a shipped build, in CI, or in a workflow.** It re-opens the impersonation hole the fix closed. It belongs in an interactive dev shell only.

Locked by tests in the same file (`should_adopt_external_false_in_release_even_on_version_match`, `release_default_does_not_adopt_external_on_version_match`, plus the dev-hatch counterparts, `port_discovery.rs:460-492`). Introduced as security fix S8 in v1.0.0 (commit `f47d1cf`); rationale in `docs/superpowers/specs/2026-06-02-clauge-v1.0.0-security-release-design.md`.

### 32. iCloud Documents entitlements live on `entitlements.mas.plist` (PARENT) ONLY — never the sidecar helper

Phase ②b publishes an analytics snapshot into the app's own iCloud container (read by the companion iOS app). The 3 iCloud Documents keys — `com.apple.developer.icloud-container-identifiers` + `com.apple.developer.ubiquity-container-identifiers` (both `["iCloud.com.clauding.clauge"]`) + `com.apple.developer.icloud-services` (`["CloudDocuments"]`) — go on `src-tauri/entitlements.mas.plist` (the parent app) and NOWHERE else. The bundled `Clauge Helper.app` (the SEA sidecar) inherits the sandbox via `com.apple.security.inherit=true` and declares no entitlements of its own; adding iCloud keys to `entitlements-sidecar.mas.plist` re-introduces the Transporter 90885 nested-profile class that file was designed to avoid (see landmine 24/25). GUARD: after a build, `codesign -d --entitlements - --xml "<Clauge Helper.app>"` shows NO icloud/ubiquity keys; the parent app shows all three.

### 33. The embedded provisioning profile must carry iCloud BEFORE the plist declares it — and the plist is a SUBSET of the profile, never a superset

Adding iCloud to the App ID in the Developer portal invalidates the existing distribution profile; it MUST be regenerated and re-downloaded to `src-tauri/embedded.provisionprofile`, or the build/Transporter rejects the entitlement. The profile is the source of truth for WHICH iCloud keys are allowed — Apple's generator emits a superset (CloudKit, KVS, dev-container, environment). The app's entitlements must be a SUBSET: declaring a key the profile lacks is the Transporter 90889 rejection vector, not a missing one. GUARD (before editing the plist): `security cms -D -i src-tauri/embedded.provisionprofile | plutil -extract Entitlements xml1 -o - - | grep -iE "icloud|ubiquity"` must return the keys; if empty, STOP and regenerate. (The "Clauge Mac App Store v0.9.0" profile carries iCloud as of build 7.)

### 34. NEVER derive the iCloud container path from `$HOME` / `NSHomeDirectory()` — only `URLForUbiquityContainerIdentifier` is correct under the sandbox

Under the App Sandbox, `$HOME` and `NSHomeDirectory()` redirect to `~/Library/Containers/com.clauding.clauge/Data`, so a home-relative path to `~/Library/Mobile Documents/…` SILENTLY DEAD-WRITES inside the sandbox container (the file never reaches iCloud). The only correct source is `NSFileManager::URLForUbiquityContainerIdentifier(Some("iCloud.com.clauding.clauge"))` (`src-tauri/src/security_scoped_bookmark.rs::resolve_icloud_container`). The ②a spike's `scripts/icloud-spike-write.cjs` worked ONLY because it ran un-sandboxed under DMG. GUARD: grep the snapshot write path for any `homedir` / `Mobile Documents` string-building — there must be none.

### 35. `NSFileCoordinator` resolve + write run in `spawn_blocking`; use `NSFileCoordinator::new()`; the `Retained<NSURL>` never crosses threads

`NSFileCoordinator` blocks the calling thread on `filecoordinationd`, and `URLForUbiquityContainerIdentifier` may block on first use — unlike the main-thread-bound objc2 in `native_popover.rs`, these MUST run on a blocking thread. EVERY resolve + the coordinated write run inside `tauri::async_runtime::spawn_blocking` (`src-tauri/src/icloud_publish.rs`), and the resolve + write live in the SAME `spawn_blocking` so the `Retained<NSURL>` (not safe to hold across `.await`) never crosses threads. Construct with the plain `NSFileCoordinator::new()` — NOT `initWithFilePresenter(alloc, None)`, which needs the unused `NSFilePresenter` objc2-foundation feature and an un-inferable `None`. The accessor block is synchronous (`Fn(NonNull<NSURL>) + '_`, no `Send` bound), so a `Cell<bool>` captured by reference safely hoists the write result out of the block. objc2-foundation features needed: exactly `NSFileManager`, `NSFileCoordinator`, `block2` (NOT `NSFilePresenter`); `block2` is also a direct dep so `block2::RcBlock` is nameable.

### 36. Coordinated iCloud write: `URLByAppendingPathComponent` (not string concat), create `Documents/` first, check BOTH error layers; the publish task is a SIBLING of the supervisor

In `src-tauri/src/icloud_writer.rs::write_snapshot_coordinated`: build `Documents/clauge-snapshot.json` by `URLByAppendingPathComponent` on the retained container `NSURL` — NEVER by Rust string-concat over `NSURL::path()` (percent-decoded). The ubiquity container does NOT auto-create `Documents/`, so `createDirectoryAtURL_withIntermediateDirectories(…, true)` must run first or `writeToURL:atomically:` silently returns `false`. Check BOTH the coordinator's `NSError` out-param AND the inner `writeToURL_atomically` bool (a `Cell<bool>`) — success on one layer with failure on the other must return `Err`, or the failure is silent. The publish loop (`icloud_publish::run`) is spawned as a SIBLING task in `lib.rs` setup (beside, NOT inside, `sidecar::spawn_and_supervise`, whose shutdown/respawn invariants are delicate); it re-resolves the container each tick (so signing into iCloud after launch starts syncing without a restart) and races `AppState::shutdown` to exit cleanly. The PARENT stamps `seq`+`writerId` and owns the write — the sidecar only assembles the JSON (`lib/snapshot.js`) — which structurally avoids the two-writer race during sidecar respawn.

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
