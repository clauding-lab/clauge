# Changelog

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
